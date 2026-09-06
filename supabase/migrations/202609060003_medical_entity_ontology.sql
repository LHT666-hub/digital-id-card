-- Medical entity normalization is deliberately separate from clinical RAG.
-- It helps map resident wording / brand names / spelling variants to canonical
-- concepts, but it is not itself a source of patient-specific medical advice.

create table if not exists public.medical_entities (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('drug','disease','gene','symptom','test','procedure','other')),
  standard_name text not null,
  normalized_name text not null,
  source_registry_id text not null,
  source_key text not null,
  authority_tier text not null default 'B',
  metadata jsonb not null default '{}'::jsonb,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_registry_id, source_key)
);

create table if not exists public.medical_entity_aliases (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.medical_entities(id) on delete cascade,
  alias text not null,
  normalized_alias text not null,
  alias_type text not null default 'synonym' check (alias_type in ('synonym','brand','abbreviation','spelling','colloquial','other')),
  source_registry_id text not null,
  created_at timestamptz not null default now(),
  unique (entity_id, normalized_alias)
);

create index if not exists idx_medical_entities_name_trgm
  on public.medical_entities using gin (normalized_name extensions.gin_trgm_ops);
create index if not exists idx_medical_entities_type_name
  on public.medical_entities(entity_type, normalized_name);
create index if not exists idx_medical_aliases_alias_trgm
  on public.medical_entity_aliases using gin (normalized_alias extensions.gin_trgm_ops);
create index if not exists idx_medical_aliases_entity
  on public.medical_entity_aliases(entity_id);

create or replace function public.resolve_medical_entities(
  p_query text,
  p_limit integer default 8
)
returns table (
  entity_id uuid,
  entity_type text,
  standard_name text,
  matched_alias text,
  match_score real,
  source_registry_id text,
  metadata jsonb
)
language sql stable security invoker set search_path = public, extensions as $$
  with params as (
    select lower(regexp_replace(trim(coalesce(p_query, '')), '\\s+', '', 'g')) as q
  ),
  candidates as (
    select
      e.id as entity_id,
      e.entity_type,
      e.standard_name,
      e.standard_name as matched_alias,
      greatest(
        case when e.normalized_name = params.q then 1.0 else 0 end,
        case when position(e.normalized_name in params.q) > 0 then 0.96 else 0 end,
        case when position(params.q in e.normalized_name) > 0 then 0.90 else 0 end,
        similarity(e.normalized_name, params.q)
      )::real as score,
      e.source_registry_id,
      e.metadata
    from public.medical_entities e cross join params
    where params.q <> ''
      and (
        e.normalized_name = params.q
        or position(e.normalized_name in params.q) > 0
        or position(params.q in e.normalized_name) > 0
        or similarity(e.normalized_name, params.q) > 0.35
      )

    union all

    select
      e.id,
      e.entity_type,
      e.standard_name,
      a.alias,
      greatest(
        case when a.normalized_alias = params.q then 1.0 else 0 end,
        case when position(a.normalized_alias in params.q) > 0 then 0.98 else 0 end,
        case when position(params.q in a.normalized_alias) > 0 then 0.92 else 0 end,
        similarity(a.normalized_alias, params.q)
      )::real as score,
      e.source_registry_id,
      e.metadata
    from public.medical_entity_aliases a
    join public.medical_entities e on e.id = a.entity_id
    cross join params
    where params.q <> ''
      and (
        a.normalized_alias = params.q
        or position(a.normalized_alias in params.q) > 0
        or position(params.q in a.normalized_alias) > 0
        or similarity(a.normalized_alias, params.q) > 0.35
      )
  ),
  ranked as (
    select candidates.*,
      row_number() over (partition by entity_id order by score desc) as per_entity_rank
    from candidates
  )
  select
    entity_id,
    entity_type,
    standard_name,
    matched_alias,
    score,
    source_registry_id,
    metadata
  from ranked
  where per_entity_rank = 1
  order by score desc, standard_name
  limit least(greatest(p_limit, 1), 20);
$$;

alter table public.medical_entities enable row level security;
alter table public.medical_entity_aliases enable row level security;

create policy medical_entities_public_read on public.medical_entities
for select to anon, authenticated using (true);
create policy medical_aliases_public_read on public.medical_entity_aliases
for select to anon, authenticated using (true);

revoke all on public.medical_entities, public.medical_entity_aliases from anon, authenticated;
grant select on public.medical_entities, public.medical_entity_aliases to anon, authenticated;
grant execute on function public.resolve_medical_entities(text,integer) to anon, authenticated;

comment on table public.medical_entities is 'Canonical medical concepts used for entity normalization; not an authoritative clinical-answer corpus.';
comment on table public.medical_entity_aliases is 'Aliases/brand names/colloquial forms mapped to canonical medical concepts.';
comment on function public.resolve_medical_entities is 'Entity-linking helper for resident wording before trusted clinical/policy retrieval.';
