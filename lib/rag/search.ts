import { getEmbeddingProvider, vectorToSql } from "@/lib/rag/embeddings";
import { resolveMedicalEntityTerms } from "@/lib/rag/entityLinking";
import { expandRetrievalQuery } from "@/lib/rag/query";
import { rerankKnowledgeHits } from "@/lib/rag/reranker";
import type { KnowledgeSearchHit, KnowledgeVisibility, RagSupabaseClient } from "@/lib/rag/types";

type SearchRow = {
  chunk_id: string; document_id: string; source_type: string; source_id: string;
  title: string; heading: string | null; content: string; category: string;
  source_name: string; canonical_url: string; reviewed_at: string; expires_at: string | null;
  version: number; text_score: number; vector_score: number; combined_score: number;
};

const institutionalKnowledgePattern =
  /(?:家庭医生|家医|社区卫生服务中心|社区卫生|社卫|签约|门诊|排班|坐班|预约|挂号|转诊|复诊|随访|续方|配药|开药|长处方|体检|报告|检查单|化验单|健康云|政策|流程|办理|材料|地址|电话|几点|什么时候|今天|明天|本周|本月|活动|讲座|服务时间|营业时间|预防针|疫苗|接种|五四|海旅|海湾|南桥|奉贤)/;

const p0Disease = /(?:高血压|2型糖尿病|二型糖尿病|糖尿病|慢性阻塞性肺疾病|慢阻肺|COPD)/i;
const managementCue = /(?:标准|规范|指南|随访|复诊|转诊|社区管理|基层管理|健康管理|筛查|体检|肺功能|血压测量|危急|急性加重|服务|多久|几次|一年几次|家庭医生)/i;

/**
 * RAG is a verified-source tool, not a mandatory gate in front of every chat.
 * General health education and everyday questions should go straight to the
 * base model; institution-specific/current service questions and P0 disease
 * management questions use reviewed knowledge first.
 */
export function shouldSearchInstitutionalKnowledge(question: string) {
  const normalized = question.trim();
  if (institutionalKnowledgePattern.test(normalized)) return true;
  return p0Disease.test(normalized) && managementCue.test(normalized);
}

export async function searchKnowledge(input: {
  supabase: RagSupabaseClient;
  query: string;
  organizationId: string;
  communityId?: string | null;
  visibility?: KnowledgeVisibility[];
  limit?: number;
  force?: boolean;
}): Promise<KnowledgeSearchHit[]> {
  const query = input.query.trim();
  if (!query) return [];
  if (!input.force && !shouldSearchInstitutionalKnowledge(query)) return [];

  const finalLimit = Math.min(Math.max(input.limit ?? 8, 1), 20);
  const candidateLimit = Math.min(Math.max(finalLimit * 3, 12), 20);
  const baseRetrievalQuery = expandRetrievalQuery(query) || query;

  const embeddingPromise = (async () => {
    try {
      const provider = getEmbeddingProvider();
      if (!provider) return null;
      return vectorToSql((await provider.embedMany([baseRetrievalQuery]))[0]);
    } catch {
      return null;
    }
  })();
  const entityPromise = resolveMedicalEntityTerms(input.supabase, query, 5);

  const [queryEmbedding, entityResolution] = await Promise.all([embeddingPromise, entityPromise]);
  const retrievalQuery = [baseRetrievalQuery, ...entityResolution.terms].filter(Boolean).join(" ");

  const { data, error } = await input.supabase.rpc("search_knowledge_chunks", {
    p_query_text: retrievalQuery,
    p_query_embedding: queryEmbedding,
    p_organization_id: input.organizationId,
    p_community_id: input.communityId ?? null,
    p_visibility: input.visibility ?? ["public", "resident"],
    p_limit: candidateLimit,
  });
  if (error) {
    if (/search_knowledge_chunks|knowledge_chunks|schema cache/i.test(error.message)) return [];
    throw error;
  }

  const hits = ((data ?? []) as SearchRow[]).map((row, index) => ({
    index: index + 1, chunkId: row.chunk_id, documentId: row.document_id,
    sourceId: row.source_id, sourceType: row.source_type as KnowledgeSearchHit["sourceType"],
    title: row.title, heading: row.heading, content: row.content, category: row.category,
    sourceName: row.source_name, sourceUrl: row.canonical_url, reviewedAt: row.reviewed_at,
    expiresAt: row.expires_at, version: row.version, textScore: Number(row.text_score ?? 0),
    vectorScore: Number(row.vector_score ?? 0), combinedScore: Number(row.combined_score ?? 0),
  }));

  return rerankKnowledgeHits(query, hits, finalLimit);
}

export function buildKnowledgeCitations(hits: KnowledgeSearchHit[]) {
  const seen = new Set<string>();
  return hits.filter((hit) => {
    if (seen.has(hit.chunkId)) return false;
    seen.add(hit.chunkId);
    return true;
  }).slice(0, 5).map((hit, index) => ({ ...hit, index: index + 1 }));
}
