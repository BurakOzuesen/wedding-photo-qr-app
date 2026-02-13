-- Events table
create table if not exists public.events (
  id text primary key,
  event_name text not null,
  event_date text,
  owner_name text,
  admin_token text not null,
  created_at timestamptz not null default now()
);

-- Upload metadata table
create table if not exists public.uploads (
  id uuid primary key,
  event_id text not null references public.events(id) on delete cascade,
  guest_name text,
  original_name text not null,
  storage_path text not null,
  mime_type text not null,
  size bigint not null,
  uploaded_at timestamptz not null default now()
);

create index if not exists uploads_event_id_uploaded_at_idx
  on public.uploads(event_id, uploaded_at desc);

-- Minimum hardening for accidental public access
alter table public.events enable row level security;
alter table public.uploads enable row level security;

-- We keep RLS strict here (no public policies).
-- Server uses SUPABASE_SERVICE_ROLE_KEY, so it can still read/write.

