import { after, type NextRequest } from "next/server";
import { apiOk, createTraceId } from "@/lib/api/response";
import { searchPublicInfo } from "@/lib/publicInfoRepository";
import { processPendingKnowledgeJobs } from "@/lib/rag/indexer";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";

function schedulePendingKnowledgeIndex(traceId: string) {
  if (process.env.RAG_LAZY_INDEX_ON_READ === "false") return;

  after(async () => {
    const supabase = createSupabaseServiceRoleClient();
    if (!supabase) {
      console.error("[rag-lazy-index] service role client is not configured", { traceId });
      return;
    }

    const requested = Number(process.env.RAG_LAZY_INDEX_BATCH ?? 2);
    const limit = Math.min(Math.max(Number.isFinite(requested) ? requested : 2, 1), 5);
    try {
      const results = await processPendingKnowledgeJobs({
        supabase,
        traceId: `${traceId}:lazy-index`,
        limit,
      });
      console.info("[rag-lazy-index] batch completed", {
        traceId,
        claimed: results.length,
        completed: results.filter((item) => item.ok).length,
        failed: results.filter((item) => !item.ok).length,
      });
    } catch (error) {
      console.error("[rag-lazy-index] batch failed", {
        traceId,
        message: error instanceof Error ? error.message : String(error),
      });
      // Index refresh must never turn a successful public-info read into an
      // application error. Failed jobs retain retry metadata in Supabase.
    }
  });
}

export async function GET(request: NextRequest) {
  const traceId = createTraceId();
  const query = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  const items = await searchPublicInfo(query, { force: true });
  if (query) schedulePendingKnowledgeIndex(traceId);
  return apiOk({ items, query, verifiedCount: items.filter((item) => !item.stale).length }, traceId);
}
