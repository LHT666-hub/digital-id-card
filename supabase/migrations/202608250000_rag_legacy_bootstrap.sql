-- Compatibility bootstrap for legacy JiaYi Supabase projects that only have
-- the early MVP tables. On a fully migrated database these statements are
-- idempotent and mostly no-op. This migration intentionally runs immediately
-- before the production RAG foundation migration (202608260001).

create extension if not exists pgcrypto;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists vector with schema extensions;

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  data_residency text not null default 'CN',
  status text not null default 'active' check (status in ('active','disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.communities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  slug text not null,
  name text not null,
  district text,
  address text,
  service_phone text,
  status text not null default 'active' check (status in ('active','disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, slug)
);

insert into public.organizations (slug, name)
values ('fengxian-primary-care', '奉贤基层家医服务试点')
on conflict (slug) do nothing;

insert into public.communities (organization_id, slug, name, district)
select id, 'haiwan-town', '海湾镇社区', '上海市奉贤区'
from public.organizations where slug = 'fengxian-primary-care'
on conflict (organization_id, slug) do nothing;

insert into public.communities (organization_id, slug, name, district)
select id, 'nanqiao-town', '南桥镇社区', '上海市奉贤区'
from public.organizations where slug = 'fengxian-primary-care'
on conflict (organization_id, slug) do nothing;

alter table public.profiles
  add column if not exists organization_id uuid references public.organizations(id),
  add column if not exists community_id uuid references public.communities(id),
  add column if not exists account_status text not null default 'active'
    check (account_status in ('pending','active','disabled'));

create or replace function public.current_app_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() limit 1
$$;

create or replace function public.current_organization_id()
returns uuid language sql stable security definer set search_path = public as $$
  select organization_id from public.profiles where id = auth.uid() limit 1
$$;

create or replace function public.current_community_id()
returns uuid language sql stable security definer set search_path = public as $$
  select community_id from public.profiles where id = auth.uid() limit 1
$$;

create or replace function public.is_workbench_role()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.current_app_role() in ('doctor','nurse','pharmacist','community','admin'), false)
$$;

create or replace function public.staff_can_access_tenant(target_organization_id uuid, target_community_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_workbench_role()
    and target_organization_id = public.current_organization_id()
    and (
      public.current_app_role() = 'admin'
      or public.current_community_id() is null
      or target_community_id is null
      or target_community_id = public.current_community_id()
    )
$$;

create table if not exists public.institutions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  short_name text,
  institution_type text not null check (institution_type in ('community','secondary','tertiary','public_service')),
  level_label text,
  address text,
  service_phone text,
  official_url text,
  registration_url text,
  logo_url text,
  source_url text,
  verified_at timestamptz,
  verified_by uuid references public.profiles(id),
  status text not null default 'active' check (status in ('active','disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, name)
);

create table if not exists public.content_sources (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  community_id uuid references public.communities(id),
  institution_id uuid references public.institutions(id),
  name text not null,
  source_type text not null check (source_type in ('official_website','rss','wechat_article','open_api','manual')),
  source_url text not null,
  allowed_host text not null,
  active boolean not null default true,
  last_fetched_at timestamptz,
  last_error text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, source_url)
);

create table if not exists public.content_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  community_id uuid references public.communities(id),
  institution_id uuid references public.institutions(id),
  source_id uuid references public.content_sources(id) on delete set null,
  category text not null check (category in ('notice','activity','health_classroom','schedule_notice','policy')),
  title text not null,
  summary text not null,
  cover_url text,
  original_url text not null,
  source_name text not null,
  published_at timestamptz,
  effective_from timestamptz,
  expires_at timestamptz,
  status text not null default 'candidate' check (status in ('candidate','in_review','published','rejected','expired')),
  ingestion_method text not null default 'url_import' check (ingestion_method in ('url_import','rss','open_api','manual')),
  content_hash text not null,
  ingested_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles(id),
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, original_url)
);

create index if not exists idx_content_feed
  on public.content_items (community_id, status, published_at desc);

create table if not exists public.public_info_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  community_id uuid references public.communities(id),
  title text not null,
  category text not null,
  content text not null,
  keywords text[] not null default '{}',
  source_name text not null,
  source_url text not null,
  effective_from date,
  expires_at timestamptz,
  verified_at timestamptz not null,
  verified_by uuid references public.profiles(id),
  status text not null default 'draft' check (status in ('draft','published','expired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_public_info_published
  on public.public_info_entries (community_id, status, verified_at desc);

insert into public.institutions (
  organization_id, name, short_name, institution_type, address, status
)
select o.id, '海湾镇社区卫生服务中心', '海湾社卫', 'community', '上海市奉贤区海湾镇民乐路55号', 'active'
from public.organizations o
where o.slug = 'fengxian-primary-care'
on conflict (organization_id, name) do nothing;

insert into public.institutions (
  organization_id, name, short_name, institution_type, address, status
)
select o.id, '南桥镇社区卫生服务中心', '南桥社卫', 'community', '上海市奉贤区南桥镇育秀东路29号', 'active'
from public.organizations o
where o.slug = 'fengxian-primary-care'
on conflict (organization_id, name) do nothing;

drop trigger if exists trg_organizations_updated_at on public.organizations;
create trigger trg_organizations_updated_at before update on public.organizations
for each row execute function public.set_updated_at();

drop trigger if exists trg_communities_updated_at on public.communities;
create trigger trg_communities_updated_at before update on public.communities
for each row execute function public.set_updated_at();

drop trigger if exists trg_institutions_updated_at on public.institutions;
create trigger trg_institutions_updated_at before update on public.institutions
for each row execute function public.set_updated_at();

drop trigger if exists trg_content_sources_updated_at on public.content_sources;
create trigger trg_content_sources_updated_at before update on public.content_sources
for each row execute function public.set_updated_at();

drop trigger if exists trg_content_items_updated_at on public.content_items;
create trigger trg_content_items_updated_at before update on public.content_items
for each row execute function public.set_updated_at();

drop trigger if exists trg_public_info_updated_at on public.public_info_entries;
create trigger trg_public_info_updated_at before update on public.public_info_entries
for each row execute function public.set_updated_at();

alter table public.organizations enable row level security;
alter table public.communities enable row level security;
alter table public.institutions enable row level security;
alter table public.content_sources enable row level security;
alter table public.content_items enable row level security;
alter table public.public_info_entries enable row level security;

drop policy if exists organizations_public_read on public.organizations;
create policy organizations_public_read on public.organizations
for select to anon, authenticated using (status = 'active');

drop policy if exists communities_public_read on public.communities;
create policy communities_public_read on public.communities
for select to anon, authenticated using (status = 'active');

drop policy if exists institutions_public_read on public.institutions;
create policy institutions_public_read on public.institutions
for select to anon, authenticated using (status = 'active');

drop policy if exists content_items_public_read on public.content_items;
create policy content_items_public_read on public.content_items
for select to anon, authenticated using (
  status = 'published' and (expires_at is null or expires_at > now())
);

drop policy if exists content_items_staff_manage on public.content_items;
create policy content_items_staff_manage on public.content_items
for all to authenticated using (public.staff_can_access_tenant(organization_id, community_id))
with check (public.staff_can_access_tenant(organization_id, community_id));

drop policy if exists public_info_public_read on public.public_info_entries;
create policy public_info_public_read on public.public_info_entries
for select to anon, authenticated using (
  status = 'published' and (expires_at is null or expires_at > now())
);

drop policy if exists public_info_staff_manage on public.public_info_entries;
create policy public_info_staff_manage on public.public_info_entries
for all to authenticated using (public.staff_can_access_tenant(organization_id, community_id))
with check (public.staff_can_access_tenant(organization_id, community_id));

drop policy if exists content_sources_staff_manage on public.content_sources;
create policy content_sources_staff_manage on public.content_sources
for all to authenticated using (public.staff_can_access_tenant(organization_id, community_id))
with check (public.staff_can_access_tenant(organization_id, community_id));

grant select on public.organizations, public.communities, public.institutions,
  public.content_items, public.public_info_entries to anon, authenticated;
grant select, insert, update, delete on public.content_sources,
  public.content_items, public.public_info_entries to authenticated;

comment on table public.public_info_entries is 'Reviewed official policy/service/medical knowledge source rows for RAG.';
comment on table public.content_items is 'Reviewed notices, activities and public content; time-sensitive rows should carry expires_at.';
