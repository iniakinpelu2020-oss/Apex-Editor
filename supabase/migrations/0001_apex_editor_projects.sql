-- Apex Editor: project storage
--
-- One row per timeline. The timeline itself is JSON so the editor's state shape can evolve
-- without a migration every time; schema_version is there so old projects can be upgraded
-- instead of silently failing to load.
--
-- Paste this into the Supabase SQL editor, or run it as a migration.

create table if not exists public.apex_editor_projects (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  title          text not null default 'Untitled project',
  aspect         text not null default '16:9'
                   check (aspect in ('16:9', '9:16', '1:1')),
  timeline       jsonb not null default '{}'::jsonb,
  schema_version int   not null default 1,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table public.apex_editor_projects is
  'Apex Editor timelines. One row per project, owned by exactly one user.';

-- The only query the app makes on start: "my projects, newest first".
create index if not exists apex_editor_projects_owner_updated_idx
  on public.apex_editor_projects (user_id, updated_at desc);

-- ---------------------------------------------------------------- security
-- RLS is the real boundary. The owner-UID check in the frontend is convenience only,
-- because anything compiled into the bundle is readable by anyone.

alter table public.apex_editor_projects enable row level security;

drop policy if exists "owner can read own projects"   on public.apex_editor_projects;
drop policy if exists "owner can insert own projects" on public.apex_editor_projects;
drop policy if exists "owner can update own projects" on public.apex_editor_projects;
drop policy if exists "owner can delete own projects" on public.apex_editor_projects;

create policy "owner can read own projects"
  on public.apex_editor_projects
  for select
  to authenticated
  using (auth.uid() = user_id);

-- with check stops a client from inserting a row that claims to belong to someone else.
create policy "owner can insert own projects"
  on public.apex_editor_projects
  for insert
  to authenticated
  with check (auth.uid() = user_id);

-- using decides which rows may be touched; with check decides what they may become.
-- Both are required, or a user could hand a project to another account.
create policy "owner can update own projects"
  on public.apex_editor_projects
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "owner can delete own projects"
  on public.apex_editor_projects
  for delete
  to authenticated
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------- updated_at
-- Kept in the database so a clock skew on the client cannot reorder the project list.

create or replace function public.apex_editor_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists apex_editor_projects_touch on public.apex_editor_projects;

create trigger apex_editor_projects_touch
  before update on public.apex_editor_projects
  for each row
  execute function public.apex_editor_touch_updated_at();

-- ---------------------------------------------------------------- smoke test
-- Run this after signing in as the owner in the app, to prove the policy allows you
-- and nobody else. Expect one row.
--
--   select id, title, updated_at from public.apex_editor_projects order by updated_at desc;
--
-- Then, still in the SQL editor (which runs as service role and ignores RLS), check the
-- policy exists:
--
--   select polname from pg_policy where polrelid = 'public.apex_editor_projects'::regclass;
