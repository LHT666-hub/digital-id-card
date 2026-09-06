import { createHash } from "node:crypto";
import { chunkChineseDocument } from "@/lib/rag/chunker";
import { getEmbeddingProvider, vectorToSql } from "@/lib/rag/embeddings";
import type { KnowledgeSourceType, KnowledgeVisibility, RagSupabaseClient } from "@/lib/rag/types";

const RAG_INDEXING_PROFILE = "rag-v2-title-category-alias-embedding-v1";

type ReviewedSource = {
  sourceType: KnowledgeSourceType;
  sourceId: string;
  organizationId: string;
  communityId: string | null;
  institutionId: string | null;
  title: string;
  category: string;
  sourceName: string;
  sourceUrl: string;
  content: string;
  retrievalAliases: string[];
  visibility: KnowledgeVisibility;
  effectiveFrom: string | null;
  expiresAt: string | null;
  reviewedAt: string;
  reviewedBy: string | null;
  contentHash: string;
};

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function uniqueAliases(values: unknown[]) {
  return [...new Set(values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean))];
}

function indexingHash(contentHash: string, aliases: string[]) {
  return digest(`${RAG_INDEXING_PROFILE}\n${contentHash}\n${aliases.join("\n")}`);
}

function embeddingText(source: ReviewedSource, chunk: { heading: string | null; content: string }) {
  return [
    `标题：${source.title}`,
    `类别：${source.category}`,
    source.retrievalAliases.length ? `检索别名：${source.retrievalAliases.join("；")}` : "",
    chunk.heading ? `章节：${chunk.heading}` : "",
    chunk.content,
  ].filter(Boolean).join("\n");
}

async function loadReviewedSource(
  supabase: RagSupabaseClient,
  sourceType: KnowledgeSourceType,
  sourceId: string,
): Promise<ReviewedSource> {
  const now = new Date().toISOString();
  if (sourceType === "content_item") {
    const { data, error } = await supabase.from("content_items")
      .select("id,organization_id,community_id,institution_id,title,category,summary,source_name,original_url,effective_from,expires_at,reviewed_at,reviewed_by,content_hash,status")
      .eq("id", sourceId).eq("status", "published").maybeSingle();
    if (error) throw error;
    if (!data || !data.reviewed_at || (data.expires_at && data.expires_at <= now)) throw new Error("RAG_SOURCE_NOT_ACTIVE");
    const aliases = uniqueAliases([data.category]);
    return {
      sourceType, sourceId: data.id, organizationId: data.organization_id,
      communityId: data.community_id, institutionId: data.institution_id,
      title: data.title, category: data.category, sourceName: data.source_name,
      sourceUrl: data.original_url, content: `${data.title}\n\n${data.summary}`,
      retrievalAliases: aliases,
      visibility: "public", effectiveFrom: data.effective_from, expiresAt: data.expires_at,
      reviewedAt: data.reviewed_at, reviewedBy: data.reviewed_by,
      contentHash: indexingHash(data.content_hash, aliases),
    };
  }
  if (sourceType === "public_info") {
    const { data, error } = await supabase.from("public_info_entries")
      .select("id,organization_id,community_id,title,category,content,keywords,source_name,source_url,effective_from,expires_at,verified_at,verified_by,status")
      .eq("id", sourceId).eq("status", "published").maybeSingle();
    if (error) throw error;
    if (!data || (data.expires_at && data.expires_at <= now)) throw new Error("RAG_SOURCE_NOT_ACTIVE");
    const content = `${data.title}\n\n${data.content}`;
    const aliases = uniqueAliases([data.category, ...((data.keywords as string[] | null) ?? [])]);
    return {
      sourceType, sourceId: data.id, organizationId: data.organization_id,
      communityId: data.community_id, institutionId: null, title: data.title,
      category: data.category, sourceName: data.source_name, sourceUrl: data.source_url,
      content, retrievalAliases: aliases, visibility: "public", effectiveFrom: data.effective_from,
      expiresAt: data.expires_at, reviewedAt: data.verified_at,
      reviewedBy: data.verified_by, contentHash: indexingHash(digest(content), aliases),
    };
  }
  throw new Error("RAG_MANUAL_SOURCE_NOT_IMPLEMENTED");
}

async function markJob(
  supabase: RagSupabaseClient,
  jobId: string | null,
  status: "processing" | "completed" | "failed",
  detail: { error?: string } = {},
) {
  if (!jobId) return;
  const now = new Date().toISOString();
  if (status === "failed") {
    const { data: job } = await supabase.from("knowledge_index_jobs")
      .select("attempts").eq("id", jobId).maybeSingle();
    const attempts = Number(job?.attempts ?? 1);
    if (attempts < 3) {
      const delayMs = 60_000 * (2 ** Math.max(attempts - 1, 0));
      await supabase.from("knowledge_index_jobs").update({
        status: "pending", available_at: new Date(Date.now() + delayMs).toISOString(),
        completed_at: null, last_error: detail.error ?? "RAG_INDEX_FAILED",
      }).eq("id", jobId);
      return;
    }
  }
  const update: Record<string, unknown> = { status, last_error: detail.error ?? null };
  if (status === "processing") Object.assign(update, { started_at: now, attempts: 1 });
  else Object.assign(update, { completed_at: now });
  await supabase.from("knowledge_index_jobs").update(update).eq("id", jobId);
}

export async function indexKnowledgeSource(input: {
  supabase: RagSupabaseClient;
  sourceType: KnowledgeSourceType;
  sourceId: string;
  actorId: string | null;
  traceId: string;
  claimedJobId?: string;
}) {
  const { supabase, sourceType, sourceId, actorId, traceId } = input;
  let jobId: string | null = input.claimedJobId ?? null;
  let documentId: string | null = null;
  let versionId: string | null = null;
  try {
    if (!jobId) {
      const { data: openJob } = await supabase.from("knowledge_index_jobs")
        .select("id,attempts").eq("source_type", sourceType).eq("source_id", sourceId)
        .in("status", ["pending", "processing"]).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (openJob) {
        jobId = openJob.id;
        const jobUpdate: Record<string, unknown> = {
          status: "processing", started_at: new Date().toISOString(),
          attempts: Number(openJob.attempts ?? 0) + 1, trace_id: traceId,
        };
        if (actorId) jobUpdate.requested_by = actorId;
        await supabase.from("knowledge_index_jobs").update(jobUpdate).eq("id", jobId);
      }
    }

    const source = await loadReviewedSource(supabase, sourceType, sourceId);
    if (!jobId) {
      const { data: createdJob, error: createJobError } = await supabase.from("knowledge_index_jobs")
        .insert({
          organization_id: source.organizationId, source_type: sourceType, source_id: sourceId,
          requested_by: actorId, source_hash: source.contentHash, status: "processing",
          attempts: 1, started_at: new Date().toISOString(), trace_id: traceId,
        }).select("id").single();
      if (createJobError) throw createJobError;
      jobId = createdJob.id;
    }
    const { data: existingDocument, error: readError } = await supabase.from("knowledge_documents")
      .select("id,current_version,content_hash,status,last_error").eq("source_type", sourceType).eq("source_id", sourceId).maybeSingle();
    if (readError) throw readError;
    const provider = getEmbeddingProvider();
    let currentEmbeddingMatches = true;
    if (existingDocument?.current_version) {
      const { data: currentVersion, error: currentVersionError } = await supabase.from("knowledge_document_versions")
        .select("embedding_model,embedding_dimensions,status").eq("document_id", existingDocument.id)
        .eq("version", existingDocument.current_version).maybeSingle();
      if (currentVersionError) throw currentVersionError;
      currentEmbeddingMatches = currentVersion?.status === "indexed"
        && (provider
          ? currentVersion.embedding_model === provider.model && currentVersion.embedding_dimensions === provider.dimensions
          : !currentVersion.embedding_model);
    }
    if (existingDocument?.status === "active" && existingDocument.content_hash === source.contentHash
      && !existingDocument.last_error && currentEmbeddingMatches) {
      await markJob(supabase, jobId, "completed");
      return { documentId: existingDocument.id, version: existingDocument.current_version, unchanged: true, chunkCount: 0 };
    }

    const nextVersion = Number(existingDocument?.current_version ?? 0) + 1;
    const documentPayload = {
      organization_id: source.organizationId, community_id: source.communityId,
      institution_id: source.institutionId, source_type: source.sourceType,
      source_id: source.sourceId, title: source.title, category: source.category,
      source_name: source.sourceName, canonical_url: source.sourceUrl,
      visibility: source.visibility, status: "indexing", effective_from: source.effectiveFrom,
      expires_at: source.expiresAt, reviewed_at: source.reviewedAt,
      reviewed_by: source.reviewedBy, content_hash: source.contentHash,
      last_error: null, metadata: {
        traceId, indexedBy: actorId ?? "system", indexingProfile: RAG_INDEXING_PROFILE,
        retrievalAliases: source.retrievalAliases,
      },
    };
    if (existingDocument) {
      documentId = existingDocument.id;
    } else {
      const { data: document, error: documentError } = await supabase.from("knowledge_documents")
        .insert(documentPayload).select("id,current_version").single();
      if (documentError) throw documentError;
      documentId = document.id;
    }

    const chunks = chunkChineseDocument(source.content);
    if (!chunks.length) throw new Error("RAG_SOURCE_EMPTY_AFTER_CHUNKING");
    const { data: existingVersion } = await supabase.from("knowledge_document_versions")
      .select("id,version,status").eq("document_id", documentId).eq("content_hash", source.contentHash).maybeSingle();
    if (existingVersion?.status === "indexed" && currentEmbeddingMatches) {
      await supabase.from("knowledge_documents").update({
        status: "active", current_version: existingVersion.version,
        last_indexed_at: new Date().toISOString(), last_error: null,
      }).eq("id", documentId);
      await markJob(supabase, jobId, "completed");
      return { documentId, version: existingVersion.version, unchanged: true, chunkCount: chunks.length };
    }

    const { data: version, error: versionError } = await supabase.from("knowledge_document_versions")
      .upsert({
        document_id: documentId, version: nextVersion, content: source.content,
        content_hash: source.contentHash, status: "pending", embedding_model: provider?.model ?? null,
        embedding_dimensions: provider?.dimensions ?? null,
        chunking_strategy: "zh-structural-v2-alias-embedding",
      }, { onConflict: "document_id,content_hash" })
      .select("id,version").single();
    if (versionError) throw versionError;
    versionId = version.id;

    const vectors = provider
      ? await provider.embedMany(chunks.map((chunk) => embeddingText(source, chunk)))
      : null;
    await supabase.from("knowledge_chunks").delete().eq("version_id", versionId);
    const { error: chunkError } = await supabase.from("knowledge_chunks").insert(chunks.map((chunk, index) => ({
      document_id: documentId, version_id: versionId, organization_id: source.organizationId,
      community_id: source.communityId, institution_id: source.institutionId,
      ordinal: chunk.ordinal, heading: chunk.heading, content: chunk.content,
      char_count: chunk.charCount, content_hash: chunk.contentHash,
      embedding: vectors ? vectorToSql(vectors[index]) : null,
      embedding_model: provider?.model ?? null,
      metadata: {
        sourceType, sourceId, reviewedAt: source.reviewedAt,
        indexingProfile: RAG_INDEXING_PROFILE, retrievalAliases: source.retrievalAliases,
      },
    })));
    if (chunkError) throw chunkError;

    const indexedAt = new Date().toISOString();
    await supabase.from("knowledge_document_versions").update({ status: "superseded" })
      .eq("document_id", documentId).eq("status", "indexed").neq("id", versionId);
    const { error: publishVersionError } = await supabase.from("knowledge_document_versions")
      .update({ status: "indexed", indexed_at: indexedAt, last_error: null }).eq("id", versionId);
    if (publishVersionError) throw publishVersionError;
    const { error: publishDocumentError } = await supabase.from("knowledge_documents")
      .update({
        organization_id: source.organizationId, community_id: source.communityId,
        institution_id: source.institutionId, title: source.title, category: source.category,
        source_name: source.sourceName, canonical_url: source.sourceUrl,
        visibility: source.visibility, effective_from: source.effectiveFrom,
        expires_at: source.expiresAt, reviewed_at: source.reviewedAt,
        reviewed_by: source.reviewedBy, content_hash: source.contentHash,
        metadata: {
          traceId, indexedBy: actorId ?? "system", indexingProfile: RAG_INDEXING_PROFILE,
          retrievalAliases: source.retrievalAliases,
        }, status: "active", current_version: version.version,
        last_indexed_at: indexedAt, last_error: null,
      }).eq("id", documentId);
    if (publishDocumentError) throw publishDocumentError;
    await markJob(supabase, jobId, "completed");
    return {
      documentId, version: version.version, unchanged: false, chunkCount: chunks.length,
      embeddingModel: provider?.model ?? null, indexingProfile: RAG_INDEXING_PROFILE,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : "RAG_INDEX_FAILED";
    if (versionId) await supabase.from("knowledge_document_versions")
      .update({ status: "failed", last_error: message }).eq("id", versionId);
    if (documentId) {
      await supabase.from("knowledge_documents").update({ last_error: message }).eq("id", documentId);
      await supabase.from("knowledge_documents").update({ status: "failed" }).eq("id", documentId).eq("current_version", 0);
    }
    await markJob(supabase, jobId, "failed", { error: message });
    throw error;
  }
}

export async function processPendingKnowledgeJobs(input: {
  supabase: RagSupabaseClient;
  actorId?: string | null;
  traceId: string;
  limit?: number;
  organizationId?: string | null;
}) {
  const limit = Math.min(Math.max(input.limit ?? 5, 1), 20);
  const { data, error } = await input.supabase.rpc("claim_knowledge_index_jobs", {
    p_limit: limit,
    p_trace_id: input.traceId,
    p_organization_id: input.organizationId ?? null,
  });
  if (error) throw error;
  const results = [];
  for (const job of data ?? []) {
    try {
      results.push({ jobId: job.job_id, ok: true, result: await indexKnowledgeSource({
        supabase: input.supabase, sourceType: job.source_type as KnowledgeSourceType,
        sourceId: job.source_id, actorId: job.requested_by ?? input.actorId ?? null,
        traceId: input.traceId, claimedJobId: job.job_id,
      }) });
    } catch (jobError) {
      results.push({ jobId: job.job_id, ok: false, error: jobError instanceof Error ? jobError.message : "RAG_INDEX_FAILED" });
    }
  }
  return results;
}
