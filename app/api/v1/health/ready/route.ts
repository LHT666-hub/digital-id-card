import { apiError, apiOk, createTraceId } from "@/lib/api/response";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export async function GET() {
  const traceId = createTraceId();
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) {
    console.error("[health-ready] service role client is not configured", { traceId });
    return apiError("SERVICE_NOT_CONFIGURED", "服务端数据库尚未配置。", 503, traceId);
  }

  const startedAt = Date.now();
  const { error } = await supabase
    .from("organizations")
    .select("id", { head: true, count: "exact" })
    .limit(1);

  if (error) {
    console.error("[health-ready] database readiness check failed", {
      traceId,
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    });
    return apiError("DATABASE_NOT_READY", "数据库暂不可用。", 503, traceId);
  }

  return apiOk(
    { status: "ready", database: "ok", latencyMs: Date.now() - startedAt },
    traceId,
  );
}
