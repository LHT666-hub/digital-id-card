-- Security/performance follow-up after enabling RAG V2 on an older project.
-- Keep SECURITY DEFINER helpers available only to roles that need them for RLS;
-- trigger/event-trigger helpers are not callable through the public API.

alter function public.is_admin() set search_path = public;

revoke execute on function public.current_app_role() from public, anon;
revoke execute on function public.current_organization_id() from public, anon;
revoke execute on function public.current_community_id() from public, anon;
revoke execute on function public.is_workbench_role() from public, anon;
revoke execute on function public.staff_can_access_tenant(uuid, uuid) from public, anon;

-- Trigger functions should never be exposed as direct RPC endpoints.
revoke execute on function public.queue_reviewed_knowledge_source() from public, anon, authenticated;
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;

-- Authenticated callers still need tenant helper functions through RLS policies.
grant execute on function public.current_app_role() to authenticated;
grant execute on function public.current_organization_id() to authenticated;
grant execute on function public.current_community_id() to authenticated;
grant execute on function public.is_workbench_role() to authenticated;
grant execute on function public.staff_can_access_tenant(uuid, uuid) to authenticated;

-- The queue claim RPC intentionally remains executable by authenticated staff;
-- the function itself rejects non-admin/non-community callers and service_role
-- is used by the background worker.

-- Cover the foreign keys used in knowledge ingestion and retrieval paths.
create index if not exists idx_profiles_organization_id
  on public.profiles(organization_id);
create index if not exists idx_profiles_community_id
  on public.profiles(community_id);

create index if not exists idx_institutions_verified_by
  on public.institutions(verified_by);

create index if not exists idx_content_sources_community_id
  on public.content_sources(community_id);
create index if not exists idx_content_sources_institution_id
  on public.content_sources(institution_id);
create index if not exists idx_content_sources_created_by
  on public.content_sources(created_by);

create index if not exists idx_content_items_source_id
  on public.content_items(source_id);
create index if not exists idx_content_items_institution_id
  on public.content_items(institution_id);
create index if not exists idx_content_items_reviewed_by
  on public.content_items(reviewed_by);

create index if not exists idx_public_info_organization_id
  on public.public_info_entries(organization_id);
create index if not exists idx_public_info_verified_by
  on public.public_info_entries(verified_by);

create index if not exists idx_knowledge_documents_community_id
  on public.knowledge_documents(community_id);
create index if not exists idx_knowledge_documents_institution_id
  on public.knowledge_documents(institution_id);
create index if not exists idx_knowledge_documents_reviewed_by
  on public.knowledge_documents(reviewed_by);

create index if not exists idx_knowledge_chunks_document_id
  on public.knowledge_chunks(document_id);
create index if not exists idx_knowledge_chunks_community_id
  on public.knowledge_chunks(community_id);
create index if not exists idx_knowledge_chunks_institution_id
  on public.knowledge_chunks(institution_id);

create index if not exists idx_knowledge_jobs_organization_id
  on public.knowledge_index_jobs(organization_id);
create index if not exists idx_knowledge_jobs_requested_by
  on public.knowledge_index_jobs(requested_by);

comment on function public.queue_reviewed_knowledge_source()
  is 'Internal trigger only; direct anon/authenticated RPC execution is revoked.';
