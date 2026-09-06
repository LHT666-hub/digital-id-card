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
  const auth = await getApiAuthContext(request);

  // 演示环境：不接触真实视觉模型与数据库，返回明确标注的示例识别结果，
  // 让“上传图片 → 查看识别 → 确认带入对话”的完整流程在本地演示中可走通。
  if (process.env.NEXT_PUBLIC_DEMO_MODE === "true" && !auth.supabase) {
    const demoForm = await request.formData().catch(() => null);
    const demoImage = demoForm?.get("image");
    if (!(demoImage instanceof File) || demoImage.size === 0)
      return apiError("IMAGE_REQUIRED", "请先拍摄或选择一张图片。", 400, traceId);
    if (demoImage.size > maxImageBytes)
      return apiError("IMAGE_TOO_LARGE", "单张图片不能超过 4MB。", 413, traceId);
    const demoBytes = Buffer.from(await demoImage.arrayBuffer());
    if (!detectImageMediaType(demoBytes))
      return apiError("IMAGE_TYPE_UNSUPPORTED", "目前支持 JPG、PNG 和 WebP 图片。", 415, traceId);
    return apiOk(
      {
        documentType: "other",
        visibleText: [
          "【演示环境】当前为示例识别结果，未对真实图片进行识别。",
          "正式环境将由经审核的视觉模型提取图片中清晰可见的文字。",
        ],
        plainSummary: [
          "演示模式不调用真实视觉模型，这里仅展示识别结果的呈现方式。",
          "正式环境会用通俗语言复述图片中明确写出的内容，不提供诊断或处方建议。",
        ],
        questionsForClinician: [
          "这份文件里哪些内容需要我重点关注？",
          "下一步需要我提前准备或核对什么？",
        ],
        uncertainItems: ["以上为演示示例，不代表您所上传图片的真实内容。"],
        confidence: "low",
        safetyNotice:
          "识别结果可能有误，请以原始文件和医生核对为准。Claw 不提供诊断、处方或用药调整建议。",
        retained: false,
        processing: "temporary_memory_only",
        demo: true,
      },
      traceId,
    );
  }

  if (!auth.supabase || !auth.profile)
    return apiError("UNAUTHENTICATED", "请先登录。", 401, traceId);

  const form = await request.formData().catch(() => null);
  const image = form?.get("image");
  if (!(image instanceof File) || image.size === 0)
    return apiError("IMAGE_REQUIRED", "请先拍摄或选择一张图片。", 400, traceId);
  if (image.size > maxImageBytes)
    return apiError("IMAGE_TOO_LARGE", "单张图片不能超过 4MB。", 413, traceId);

  try {
    const subject = await resolveCareSubject(
      request,
      auth.profile,
      auth.supabase,
      typeof form?.get("residentId") === "string"
        ? String(form?.get("residentId"))
        : null,
    );
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
    await auth.supabase.from("skill_runs").insert({
      user_id: auth.profile.id,
      resident_id: subject.residentId,
      skill_id: "patient-document-explainer",
      skill_version: "1.1.0-vision",
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

    return apiOk(
      {
        ...result.analysis,
        processing: "temporary_memory_only",
      },
      traceId,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "DOCUMENT_ANALYSIS_FAILED";
    console.error("document-analysis-failed", {
      traceId,
      code: message.slice(0, 160),
    });
    if (message.includes("DOCUMENT_VISION_NOT_CONFIGURED"))
      return apiError(
        "DOCUMENT_VISION_UNAVAILABLE",
        "图片识别服务尚未配置，请先使用文字描述或联系家医团队。",
        503,
        traceId,
      );
    if (message.includes("Timeout") || message.includes("timeout"))
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
