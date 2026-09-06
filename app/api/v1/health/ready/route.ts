import { apiError, apiOk, createTraceId } from "@/lib/api/response";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export async function GET() {
  const traceId = createTraceId();
  // 演示模式有意绕过数据库，服务本身已就绪，探针不应报告故障。
  if (process.env.NEXT_PUBLIC_DEMO_MODE === "true")
    return apiOk({ status: "demo", database: "bypassed" }, traceId);
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return apiError("SERVICE_NOT_CONFIGURED", "服务端数据库尚未配置。", 503, traceId);
  const startedAt = Date.now();
  const { error } = await supabase.from("organizations").select("id", { head: true, count: "exact" }).limit(1);
  if (error) return apiError("DATABASE_NOT_READY", "数据库暂不可用。", 503, traceId);
  return apiOk({ status: "ready", database: "ok", latencyMs: Date.now() - startedAt }, traceId);
}
