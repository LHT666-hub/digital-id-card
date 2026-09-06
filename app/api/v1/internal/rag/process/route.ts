import type { NextRequest } from "next/server";
import { apiError, apiOk, createTraceId, readErrorMessage } from "@/lib/api/response";
import { processPendingKnowledgeJobs } from "@/lib/rag/indexer";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

async function run(request: NextRequest) {
  const traceId = createTraceId();
  const secret = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return apiError("UNAUTHORIZED", "无权执行知识索引任务。", 401, traceId);
  }
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return apiError("SERVICE_NOT_CONFIGURED", "服务端数据库尚未配置。", 503, traceId);

  try {
    const results = [];
    const batchSize = 10;
    for (let batch = 0; batch < 4; batch += 1) {
      const current = await processPendingKnowledgeJobs({
        supabase,
        traceId: batch ? `${traceId}:${batch + 1}` : traceId,
        limit: batchSize,
      });
      results.push(...current);
      if (current.length < batchSize) break;
    }
    return apiOk({
      claimed: results.length,
      completed: results.filter((item) => item.ok).length,
      failed: results.filter((item) => !item.ok).length,
      results,
    }, traceId);
  } catch (error) {
    return apiError("RAG_WORKER_FAILED", readErrorMessage(error), 500, traceId);
  }
}

export const GET = run;
export const POST = run;
