-- Fix polymorphic trigger record access. Referencing NEW.content_hash inside a
-- CASE expression still fails for public_info_entries because that table does
-- not have the column. Branch first, then access table-specific fields.

create or replace function public.queue_reviewed_knowledge_source()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  source_kind text := tg_argv[0];
  source_status text;
  source_hash_value text;
  source_org uuid;
begin
  source_status := new.status;
  source_org := new.organization_id;

  if source_kind = 'content_item' then
    source_hash_value := new.content_hash;
  elsif source_kind = 'public_info' then
    source_hash_value := md5(new.title || E'\n' || new.content);
  else
    raise exception 'UNSUPPORTED_KNOWLEDGE_SOURCE_TYPE: %', source_kind;
  end if;

  if source_status = 'published' and (new.expires_at is null or new.expires_at > now()) then
    insert into public.knowledge_index_jobs (
      organization_id, source_type, source_id, requested_by, source_hash, status
    ) values (
      source_org, source_kind, new.id, auth.uid(), source_hash_value, 'pending'
    ) on conflict (source_type, source_id) where status in ('pending','processing')
      do update set source_hash = excluded.source_hash, available_at = now(),
        status = case when knowledge_index_jobs.status = 'processing' then 'processing' else 'pending' end;
  elsif source_status in ('expired','rejected') then
    update public.knowledge_documents
      set status = 'expired', last_error = null
      where source_type = source_kind and source_id = new.id;
    update public.knowledge_index_jobs
      set status = 'cancelled', completed_at = now()
      where source_type = source_kind and source_id = new.id and status = 'pending';
  end if;
  return new;
end;
$$;

revoke execute on function public.queue_reviewed_knowledge_source() from public, anon, authenticated;

comment on function public.queue_reviewed_knowledge_source()
  is 'Queues reviewed content/public-info without referencing fields that do not exist on the active trigger table; internal trigger only.';
