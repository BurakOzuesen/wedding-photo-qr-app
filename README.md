# Anilar Bulutta Clone (MVP)

QR kod ile etkinlikte misafirlerden foto/video toplama uygulamasi.

## Ozellikler

- Etkinlik olusturma
- Etkinlige ozel misafir linki (`/e/:eventId`)
- Coklu foto/video yukleme
- Etkinlik sahibine ozel admin galeri (`/admin/:eventId`, HttpOnly cookie auth)
- Admin panelden toplu ZIP indirme
- QR kod uretimi
- `local` veya `supabase` backend secimi

## 1) Lokal Gelistirme

```bash
cp .env.example .env
npm install
npm run dev
```

Ac: `http://localhost:3000`

Varsayilan `.env` modu `STORAGE_BACKEND=local` oldugu icin dosyalar `uploads/` altina, metadata `data/db.json` dosyasina yazilir.

## 2) Supabase Hazirligi (Cloud Icin)

Supabase projesinde:

1. SQL Editor'de `supabase/schema.sql` dosyasini calistir.
2. Storage -> yeni bucket olustur: `event-media` (adi `.env` ile ayni olmali).
3. Project Settings -> API'den su bilgileri al:
- `Project URL` -> `SUPABASE_URL`
- `service_role` secret -> `SUPABASE_SERVICE_ROLE_KEY`

`.env` ornegi:

```env
PORT=3000
BASE_URL=
MAX_FILE_SIZE_MB=200
MAX_FILES_PER_REQUEST=20
STORAGE_BACKEND=supabase
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
SUPABASE_BUCKET=event-media
SUPABASE_SIGNED_URL_TTL_SEC=3600
ADMIN_COOKIE_TTL_SEC=2592000
RATE_LIMIT_WINDOW_SEC=60
RATE_LIMIT_EVENT_MAX=20
RATE_LIMIT_UPLOAD_MAX=60
```

## 3) Render Deploy

Bu repo icinde `render.yaml` var. Render uzerinde yeni Web Service olustururken repo'yu sec ve deploy et.

Gerekli env var'lar:

- `STORAGE_BACKEND=supabase`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_BUCKET=event-media`
- `BASE_URL=https://<render-app-domain>`
- `ADMIN_COOKIE_TTL_SEC=2592000`
- `RATE_LIMIT_WINDOW_SEC=60`
- `RATE_LIMIT_EVENT_MAX=20`
- `RATE_LIMIT_UPLOAD_MAX=60`

Start command: `npm start`

## 4) Railway Deploy

Railway'de repo'yu bagla, asagidaki env var'lari ekle ve deploy et:

- `STORAGE_BACKEND=supabase`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_BUCKET=event-media`
- `BASE_URL=https://<railway-app-domain>`
- `ADMIN_COOKIE_TTL_SEC=2592000`
- `RATE_LIMIT_WINDOW_SEC=60`
- `RATE_LIMIT_EVENT_MAX=20`
- `RATE_LIMIT_UPLOAD_MAX=60`

Railway `npm start` komutunu otomatik algilar (gerekirse Start Command alanina `npm start` yaz).

## Notlar

- Bu proje MVP'dir; temel rate limit + dosya signature kontrolu var, production icin malware scanning ve daha detayli auth katmanlari eklenmeli.
- Eski `?token=` linkleri geriye donuk olarak calisir ama yeni akista admin yetkisi HttpOnly cerezde tutulur.
