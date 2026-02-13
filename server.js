import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import archiver from "archiver";
import dotenv from "dotenv";
import express from "express";
import multer from "multer";
import QRCode from "qrcode";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, "data");
const UPLOADS_DIR = path.join(__dirname, "uploads");
const DB_FILE = path.join(DATA_DIR, "db.json");

const PORT = Number(process.env.PORT || 3000);
const MAX_FILE_SIZE_MB = Number(process.env.MAX_FILE_SIZE_MB || 200);
const MAX_FILES_PER_REQUEST = Number(process.env.MAX_FILES_PER_REQUEST || 20);
const STORAGE_BACKEND = String(process.env.STORAGE_BACKEND || "local").toLowerCase();
const SUPABASE_BUCKET = String(process.env.SUPABASE_BUCKET || "event-media");
const SUPABASE_SIGNED_URL_TTL_SEC = Number(
  process.env.SUPABASE_SIGNED_URL_TTL_SEC || 60 * 60
);

const USING_SUPABASE = STORAGE_BACKEND === "supabase";

const supabase = createSupabaseClient();
if (!USING_SUPABASE) {
  bootstrapLocal();
}

const app = express();
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.set("trust proxy", 1);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const fileFilter = (req, file, cb) => {
  const validType =
    file.mimetype.startsWith("image/") || file.mimetype.startsWith("video/");
  if (!validType) {
    cb(new Error("Sadece foto veya video yuklenebilir."));
    return;
  }
  cb(null, true);
};

const uploadDiskStorage = multer.diskStorage({
  destination(req, file, cb) {
    const eventId = req.params.eventId;
    const eventDir = path.join(UPLOADS_DIR, eventId);
    fs.mkdirSync(eventDir, { recursive: true });
    cb(null, eventDir);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname || "");
    cb(null, `${Date.now()}-${crypto.randomUUID()}${ext}`);
  }
});

const uploadLocal = multer({
  storage: uploadDiskStorage,
  limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024, files: MAX_FILES_PER_REQUEST },
  fileFilter
});

const uploadSupabase = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024, files: MAX_FILES_PER_REQUEST },
  fileFilter
});

app.get("/", (req, res) => {
  res.render("home");
});

app.get("/healthz", (req, res) => {
  res.json({ ok: true, backend: STORAGE_BACKEND });
});

app.post("/api/events", async (req, res, next) => {
  try {
    const eventName = sanitizeText(req.body.eventName, 120);
    const eventDate = sanitizeText(req.body.eventDate, 40);
    const ownerName = sanitizeText(req.body.ownerName, 80);

    if (!eventName) {
      res.status(400).json({ error: "Etkinlik adi zorunlu." });
      return;
    }

    const event = await createEventRecord({ eventName, eventDate, ownerName });
    const baseUrl = getBaseUrl(req);

    res.status(201).json({
      eventId: event.id,
      joinUrl: `${baseUrl}/e/${event.id}`,
      adminUrl: `${baseUrl}/admin/${event.id}?token=${event.adminToken}`
    });
  } catch (error) {
    next(error);
  }
});

app.get("/created/:eventId", async (req, res, next) => {
  try {
    const token = String(req.query.token || "");
    const eventId = req.params.eventId;
    const event = await findEventById(eventId);

    if (!event || event.adminToken !== token) {
      res.status(403).send("Yetkisiz erisim.");
      return;
    }

    const baseUrl = getBaseUrl(req);
    const joinUrl = `${baseUrl}/e/${eventId}`;
    const adminUrl = `${baseUrl}/admin/${eventId}?token=${token}`;
    const qrDataUrl = await QRCode.toDataURL(joinUrl);

    res.render("created", { event, joinUrl, adminUrl, qrDataUrl, token });
  } catch (error) {
    next(error);
  }
});

app.get("/e/:eventId", async (req, res, next) => {
  try {
    const eventId = req.params.eventId;
    const event = await findEventById(eventId);

    if (!event) {
      res.status(404).send("Etkinlik bulunamadi.");
      return;
    }

    res.render("event", { event, maxFileSizeMb: MAX_FILE_SIZE_MB });
  } catch (error) {
    next(error);
  }
});

app.post("/api/e/:eventId/upload", async (req, res) => {
  const eventId = req.params.eventId;

  try {
    const event = await findEventById(eventId);
    if (!event) {
      res.status(404).json({ error: "Etkinlik bulunamadi." });
      return;
    }

    const middleware = USING_SUPABASE ? uploadSupabase : uploadLocal;

    middleware.array("files", MAX_FILES_PER_REQUEST)(req, res, async (err) => {
      if (err) {
        res.status(400).json({ error: err.message || "Dosya yuklenemedi." });
        return;
      }

      const files = Array.isArray(req.files) ? req.files : [];
      if (!files.length) {
        res.status(400).json({ error: "En az bir dosya secmelisin." });
        return;
      }

      const guestName = sanitizeText(req.body.guestName, 80);
      const uploadedAt = new Date().toISOString();
      const uploadRecords = [];
      const createdStoragePaths = [];

      try {
        if (USING_SUPABASE) {
          for (const file of files) {
            const ext = path.extname(file.originalname || "");
            const storagePath = `${eventId}/${Date.now()}-${crypto.randomUUID()}${ext}`;

            const { error: uploadError } = await supabase.storage
              .from(SUPABASE_BUCKET)
              .upload(storagePath, file.buffer, {
                cacheControl: "3600",
                contentType: file.mimetype,
                upsert: false
              });

            if (uploadError) {
              throw uploadError;
            }

            createdStoragePaths.push(storagePath);
            uploadRecords.push({
              id: crypto.randomUUID(),
              eventId,
              guestName,
              originalName: file.originalname,
              storagePath,
              mimeType: file.mimetype,
              size: file.size,
              uploadedAt
            });
          }
        } else {
          for (const file of files) {
            uploadRecords.push({
              id: crypto.randomUUID(),
              eventId,
              guestName,
              originalName: file.originalname,
              storagePath: file.filename,
              mimeType: file.mimetype,
              size: file.size,
              uploadedAt
            });
          }
        }

        await insertUploadRecords(uploadRecords);
        res.status(201).json({ ok: true, uploadedCount: files.length });
      } catch (error) {
        if (USING_SUPABASE && createdStoragePaths.length) {
          // Metadata yazimi basarisiz olursa yuklenen dosyalari temizliyoruz.
          await Promise.allSettled(
            createdStoragePaths.map((storagePath) =>
              supabase.storage.from(SUPABASE_BUCKET).remove([storagePath])
            )
          );
        }

        const message = error instanceof Error ? error.message : "Dosya yuklenemedi.";
        res.status(500).json({ error: message });
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Dosya yuklenemedi.";
    res.status(500).json({ error: message });
  }
});

app.get("/admin/:eventId", async (req, res, next) => {
  try {
    const eventId = req.params.eventId;
    const token = String(req.query.token || "");

    const event = await findEventById(eventId);
    if (!event) {
      res.status(404).send("Etkinlik bulunamadi.");
      return;
    }
    if (event.adminToken !== token) {
      res.status(403).send("Yetkisiz erisim.");
      return;
    }

    const baseUrl = getBaseUrl(req);
    const joinUrl = `${baseUrl}/e/${eventId}`;
    const qrDataUrl = await QRCode.toDataURL(joinUrl);

    const uploads = await listUploadsForEvent(eventId);
    const uploadsWithUrls = await attachViewUrls(uploads, token);

    res.render("admin", {
      event,
      token,
      uploads: uploadsWithUrls,
      joinUrl,
      qrDataUrl
    });
  } catch (error) {
    next(error);
  }
});

app.get("/admin/:eventId/download.zip", async (req, res, next) => {
  const eventId = req.params.eventId;
  const token = String(req.query.token || "");

  try {
    const event = await findEventById(eventId);
    if (!event) {
      res.status(404).send("Etkinlik bulunamadi.");
      return;
    }
    if (event.adminToken !== token) {
      res.status(403).send("Yetkisiz erisim.");
      return;
    }

    const uploads = await listUploadsForEvent(eventId);
    if (!uploads.length) {
      res.status(404).send("Indirilecek dosya yok.");
      return;
    }

    const safeEventName = sanitizeArchiveName(event.eventName || "anilar");
    const zipFileName = `${safeEventName}-${eventId}.zip`;

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${zipFileName}"`);

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("warning", (error) => {
      if (error.code !== "ENOENT") {
        console.warn(error);
      }
    });
    archive.on("error", (error) => {
      console.error(error);
      if (!res.headersSent) {
        res.status(500).send("ZIP olusturulamadi.");
        return;
      }
      res.destroy(error);
    });

    archive.pipe(res);

    if (USING_SUPABASE) {
      await appendSupabaseUploadsToArchive(archive, uploads);
    } else {
      appendLocalUploadsToArchive(archive, eventId, uploads);
    }

    await archive.finalize();
  } catch (error) {
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    next(error);
  }
});

app.get("/admin/file/:eventId/:fileName", async (req, res) => {
  if (USING_SUPABASE) {
    res.status(404).send("Bu endpoint local depolama icindir.");
    return;
  }

  const eventId = req.params.eventId;
  const fileName = path.basename(req.params.fileName);
  const token = String(req.query.token || "");

  const event = await findEventById(eventId);
  if (!event || event.adminToken !== token) {
    res.status(403).send("Yetkisiz erisim.");
    return;
  }

  const filePath = path.join(UPLOADS_DIR, eventId, fileName);
  if (!fs.existsSync(filePath)) {
    res.status(404).send("Dosya bulunamadi.");
    return;
  }
  res.sendFile(filePath);
});

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) {
    next(err);
    return;
  }
  res.status(500).json({ error: "Beklenmeyen bir hata olustu." });
});

app.listen(PORT, () => {
  console.log(`Server calisiyor: http://localhost:${PORT} (${STORAGE_BACKEND})`);
});

function createSupabaseClient() {
  if (!USING_SUPABASE) {
    return null;
  }

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error(
      "STORAGE_BACKEND=supabase icin SUPABASE_URL ve SUPABASE_SERVICE_ROLE_KEY zorunlu."
    );
  }

  return createClient(url, serviceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}

function bootstrapLocal() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    const base = { events: [], uploads: [] };
    fs.writeFileSync(DB_FILE, JSON.stringify(base, null, 2));
  }
}

function readLocalDb() {
  try {
    const content = fs.readFileSync(DB_FILE, "utf-8");
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed.events) || !Array.isArray(parsed.uploads)) {
      throw new Error("Bozuk db");
    }
    return parsed;
  } catch {
    const fallback = { events: [], uploads: [] };
    writeLocalDb(fallback);
    return fallback;
  }
}

function writeLocalDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

async function createEventRecord({ eventName, eventDate, ownerName }) {
  const createdAt = new Date().toISOString();

  if (USING_SUPABASE) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const eventId = generateShortId();
      const adminToken = crypto.randomBytes(16).toString("hex");

      const { error } = await supabase.from("events").insert({
        id: eventId,
        event_name: eventName,
        event_date: eventDate || null,
        owner_name: ownerName || null,
        admin_token: adminToken,
        created_at: createdAt
      });

      if (!error) {
        return {
          id: eventId,
          eventName,
          eventDate,
          ownerName,
          adminToken,
          createdAt
        };
      }

      if (error.code !== "23505") {
        throw error;
      }
    }

    throw new Error("Etkinlik olusturulamadi, tekrar dene.");
  }

  const db = readLocalDb();
  let eventId = generateShortId();
  while (db.events.some((event) => event.id === eventId)) {
    eventId = generateShortId();
  }

  const adminToken = crypto.randomBytes(16).toString("hex");
  const event = {
    id: eventId,
    eventName,
    eventDate,
    ownerName,
    adminToken,
    createdAt
  };

  db.events.push(event);
  writeLocalDb(db);
  return event;
}

async function findEventById(eventId) {
  if (USING_SUPABASE) {
    const { data, error } = await supabase
      .from("events")
      .select("id,event_name,event_date,owner_name,admin_token,created_at")
      .eq("id", eventId)
      .maybeSingle();

    if (error) {
      throw error;
    }
    if (!data) {
      return null;
    }

    return {
      id: data.id,
      eventName: data.event_name,
      eventDate: data.event_date || "",
      ownerName: data.owner_name || "",
      adminToken: data.admin_token,
      createdAt: data.created_at
    };
  }

  const db = readLocalDb();
  return db.events.find((event) => event.id === eventId) || null;
}

async function insertUploadRecords(records) {
  if (!records.length) {
    return;
  }

  if (USING_SUPABASE) {
    const payload = records.map((item) => ({
      id: item.id,
      event_id: item.eventId,
      guest_name: item.guestName || null,
      original_name: item.originalName,
      storage_path: item.storagePath,
      mime_type: item.mimeType,
      size: item.size,
      uploaded_at: item.uploadedAt
    }));

    const { error } = await supabase.from("uploads").insert(payload);
    if (error) {
      throw error;
    }
    return;
  }

  const db = readLocalDb();
  db.uploads.push(...records);
  writeLocalDb(db);
}

async function listUploadsForEvent(eventId) {
  if (USING_SUPABASE) {
    const { data, error } = await supabase
      .from("uploads")
      .select("id,event_id,guest_name,original_name,storage_path,mime_type,size,uploaded_at")
      .eq("event_id", eventId)
      .order("uploaded_at", { ascending: false });

    if (error) {
      throw error;
    }

    return (data || []).map((item) => ({
      id: item.id,
      eventId: item.event_id,
      guestName: item.guest_name || "",
      originalName: item.original_name,
      storagePath: item.storage_path,
      mimeType: item.mime_type,
      size: item.size,
      uploadedAt: item.uploaded_at
    }));
  }

  const db = readLocalDb();
  return db.uploads
    .filter((item) => item.eventId === eventId)
    .map((item) => ({
      ...item,
      storagePath: item.storagePath || item.storedName || ""
    }))
    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
}

async function attachViewUrls(uploads, token) {
  if (!uploads.length) {
    return uploads;
  }

  if (USING_SUPABASE) {
    const paths = uploads.map((item) => item.storagePath);
    const { data, error } = await supabase.storage
      .from(SUPABASE_BUCKET)
      .createSignedUrls(paths, SUPABASE_SIGNED_URL_TTL_SEC);

    if (error) {
      throw error;
    }

    return uploads.map((item, index) => ({
      ...item,
      viewUrl: data?.[index]?.signedUrl || ""
    }));
  }

  return uploads.map((item) => ({
    ...item,
    viewUrl: `/admin/file/${encodeURIComponent(item.eventId)}/${encodeURIComponent(
      item.storagePath
    )}?token=${encodeURIComponent(token)}`
  }));
}

async function appendSupabaseUploadsToArchive(archive, uploads) {
  for (let index = 0; index < uploads.length; index += 1) {
    const item = uploads[index];
    const { data, error } = await supabase.storage
      .from(SUPABASE_BUCKET)
      .createSignedUrl(item.storagePath, SUPABASE_SIGNED_URL_TTL_SEC);

    if (error || !data?.signedUrl) {
      throw error || new Error("Supabase dosya URL olusturma hatasi.");
    }

    const response = await fetch(data.signedUrl);
    if (!response.ok || !response.body) {
      throw new Error(`Supabase dosya indirme hatasi: ${item.originalName}`);
    }

    archive.append(Readable.fromWeb(response.body), {
      name: buildArchiveEntryName(item, index)
    });
  }
}

function appendLocalUploadsToArchive(archive, eventId, uploads) {
  for (let index = 0; index < uploads.length; index += 1) {
    const item = uploads[index];
    const filePath = path.join(UPLOADS_DIR, eventId, item.storagePath);

    if (!fs.existsSync(filePath)) {
      continue;
    }

    archive.file(filePath, {
      name: buildArchiveEntryName(item, index)
    });
  }
}

function buildArchiveEntryName(upload, index) {
  const prefix = String(index + 1).padStart(3, "0");
  const originalName = upload.originalName || path.basename(upload.storagePath || "");
  const safeName = sanitizeArchiveName(originalName);

  if (path.extname(safeName)) {
    return `${prefix}-${safeName}`;
  }

  const fallbackExt =
    path.extname(upload.storagePath || "") || getExtensionFromMime(upload.mimeType);
  return `${prefix}-${safeName}${fallbackExt}`;
}

function getExtensionFromMime(mimeType = "") {
  const extensions = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/heic": ".heic",
    "image/heif": ".heif",
    "image/gif": ".gif",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm"
  };

  return extensions[mimeType] || "";
}

function sanitizeArchiveName(value) {
  if (typeof value !== "string") {
    return "arsiv";
  }

  const safe = value
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);

  return safe || "arsiv";
}

function generateShortId() {
  return crypto.randomBytes(3).toString("hex");
}

function sanitizeText(value, max = 100) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().slice(0, max);
}

function getBaseUrl(req) {
  if (process.env.BASE_URL) {
    return process.env.BASE_URL.replace(/\/$/, "");
  }
  return `${req.protocol}://${req.get("host")}`;
}
