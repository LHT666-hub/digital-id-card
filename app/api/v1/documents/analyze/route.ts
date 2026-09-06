import type { NextRequest } from "next/server";
import { apiError, apiOk, createTraceId } from "@/lib/api/response";
import { resolveCareSubject } from "@/lib/careSubjects";
import {
  analyzeMedicalDocumentImage,
  detectImageMediaType,
} from "@/lib/documents/analysis";
import { CURRENT_POLICY_VERSION } from "@/lib/policies";
import { getApiAuthContext } from "@/lib/supabase/server-auth";

export const runtime = "nodejs";

const maxImageBytes = 4 * 1024 * 1024;

export async function POST(request: NextRequest) {
  const traceId = createTraceId();
  const startedAt = Date.now();
  const demoMode = process.env.NEXT_PUBLIC_DEMO_MODE === "true";
  const auth = await getApiAuthContext(request);
  if ((!auth.supabase || !auth.profile) && !demoMode)
    return apiError("UNAUTHENTICATED", "请先登录。", 401, traceId);

  const form = await request.formData().catch(() => null);
  const image = form?.get("image");
  if (!(image instanceof File) || image.size === 0)
    return apiError("IMAGE_REQUIRED", "请先拍摄或选择一张图片。", 400, traceId);
  if (image.size > maxImageBytes)
    return apiError("IMAGE_TOO_LARGE", "单张图片不能超过 4MB。", 413, traceId);

  try {
    let residentId: string | null = null;

    if (!demoMode) {
      if (!auth.supabase || !auth.profile) {
        return apiError("UNAUTHENTICATED", "请先登录。", 401, traceId);
      }
      const subject = await resolveCareSubject(
        request,
        auth.profile,
        auth.supabase,
        typeof form?.get("residentId") === "string"
          ? String(form?.get("residentId"))
          : null,
      );
      residentId = subject.residentId;
      const { data: consents, error: consentError } = await auth.supabase
        .from("consents")
        .select("scope,granted")
        .eq("user_id", auth.profile.id)
        .eq("resident_id", subject.residentId)
        .eq("policy_version", CURRENT_POLICY_VERSION)
        .in("scope", ["sensitive_health", "ai_processing"]);
      if (consentError) throw consentError;
      const granted = new Set(
        (consents ?? []).filter((item) => item.granted).map((item) => item.scope),
      );
      if (!granted.has("sensitive_health") || !granted.has("ai_processing")) {
        return apiError(
          "DOCUMENT_CONSENT_REQUIRED",
          "请先在“我的 - 隐私与授权”中开启敏感健康信息和 AI 辅助整理。",
          403,
          traceId,
        );
      }
    }

    const bytes = Buffer.from(await image.arrayBuffer());
    const mediaType = detectImageMediaType(bytes);
    if (!mediaType)
      return apiError(
        "IMAGE_TYPE_UNSUPPORTED",
        "目前支持 JPG、PNG 和 WebP 图片。",
        415,
        traceId,
      );

    const result = await analyzeMedicalDocumentImage(bytes, mediaType);

    if (auth.supabase && auth.profile && residentId) {
      await auth.supabase.from("skill_runs").insert({
        user_id: auth.profile.id,
        resident_id: residentId,
        skill_id: "patient-document-explainer",
        skill_version: "1.1.1-vision",
        model: result.model,
        trace_id: traceId,
        status: "success",
        latency_ms: Date.now() - startedAt,
        metadata: {
          imageBytes: image.size,
          mediaType,
          documentType: result.analysis.documentType,
          confidence: result.analysis.confidence,
          retained: false,
        },
      });
    }

    return apiOk(
      {
        ...result.analysis,
        processing: "temporary_memory_only",
        demo: demoMode,
      },
      traceId,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "DOCUMENT_ANALYSIS_FAILED";
    console.error("document-analysis-failed", {
      traceId,
      code: message.slice(0, 240),
    });
    if (message.includes("DOCUMENT_VISION_NOT_CONFIGURED"))
      return apiError(
        "DOCUMENT_VISION_UNAVAILABLE",
        "图片识别服务尚未配置，请先使用文字描述或联系家医团队。",
        503,
        traceId,
      );
    if (message.includes("Timeout") || message.includes("timeout") || message.includes("aborted"))
      return apiError(
        "DOCUMENT_ANALYSIS_TIMEOUT",
        "图片识别时间较长，请稍后重试。",
        504,
        traceId,
      );
    return apiError(
      "DOCUMENT_ANALYSIS_FAILED",
      "这张图片暂时没有识别成功，请确保文字清晰后重试。",
      503,
      traceId,
    );
  }
}
