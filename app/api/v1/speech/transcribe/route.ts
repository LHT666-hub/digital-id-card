import { mkdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { NextRequest } from "next/server";
import { apiError, apiOk, createTraceId } from "@/lib/api/response";
import { speechProvider, transcribeAudio } from "@/lib/speech/transcribe";
import { getApiAuthContext } from "@/lib/supabase/server-auth";

export const runtime = "nodejs";

const maxAudioBytes = 10 * 1024 * 1024;
const allowedTypes = new Set([
  "audio/webm",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
  "audio/aac",
  "audio/x-m4a",
  "application/octet-stream",
]);

function extensionFor(file: File) {
  const mediaType = file.type.split(";", 1)[0].trim().toLowerCase();
  const byType: Record<string, string> = {
    "audio/webm": ".webm",
    "audio/mp4": ".m4a",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/ogg": ".ogg",
    "audio/aac": ".aac",
    "audio/x-m4a": ".m4a",
  };
  return byType[mediaType] ?? (path.extname(file.name).toLowerCase() || ".audio");
}

export async function POST(request: NextRequest) {
  const traceId = createTraceId();
  const startedAt = Date.now();
  const demoMode = process.env.NEXT_PUBLIC_DEMO_MODE === "true";
  const auth = await getApiAuthContext(request);
  if ((!auth.supabase || !auth.profile) && !demoMode) {
    return apiError("UNAUTHENTICATED", "请先登录。", 401, traceId);
  }

  const form = await request.formData().catch(() => null);
  const audio = form?.get("audio");
  if (!(audio instanceof File) || audio.size === 0) {
    return apiError("AUDIO_REQUIRED", "请先录制一段语音。", 400, traceId);
  }
  if (audio.size > maxAudioBytes) {
    return apiError("AUDIO_TOO_LARGE", "单次语音不能超过 10MB。", 413, traceId);
  }
  const mediaType = audio.type.split(";", 1)[0].trim().toLowerCase();
  if (mediaType && !allowedTypes.has(mediaType)) {
    return apiError("AUDIO_TYPE_UNSUPPORTED", "暂不支持这种录音格式。", 415, traceId);
  }

  const tempDir = path.join(os.tmpdir(), "jiayi-claw-asr");
  const tempFile = path.join(tempDir, `${crypto.randomUUID()}${extensionFor(audio)}`);
  try {
    await mkdir(tempDir, { recursive: true });
    await writeFile(tempFile, Buffer.from(await audio.arrayBuffer()));
    const result = await transcribeAudio(tempFile);
    if (!result.text.trim()) return apiError("NO_SPEECH", "没有听清楚，请再说一遍。", 422, traceId);

    if (auth.supabase && auth.profile) {
      await auth.supabase.from("skill_runs").insert({
        user_id: auth.profile.id,
        resident_id: auth.profile.role === "resident" ? auth.profile.id : null,
        skill_id: result.provider === "whisper-wu-local"
          ? "speech-transcription-whisper-wu"
          : result.provider === "aliyun-bailian-asr"
            ? "speech-transcription-bailian-qwen"
            : "speech-transcription-tencent-asr",
        skill_version: result.provider === "whisper-wu-local"
          ? "v09-local.1"
          : result.provider === "aliyun-bailian-asr"
            ? "qwen-asr.2"
            : "v3-sentence.1",
        model: result.model,
        trace_id: traceId,
        status: "success",
        latency_ms: Date.now() - startedAt,
        metadata: {
          provider: result.provider,
          providerRequestId: result.requestId ?? null,
          device: result.device,
          audioBytes: audio.size,
          retained: false,
        },
      });
    }

    return apiOk({
      text: result.text.trim(),
      provider: result.provider,
      model: result.model,
      device: result.device,
      requiresConfirmation: true,
      retained: false,
      providerRequestId: result.requestId ?? null,
      demo: demoMode,
    }, traceId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "ASR_FAILED";
    console.error("speech-transcription-failed", {
      traceId,
      provider: speechProvider(),
      code: message.slice(0, 240),
    });
    if (message.includes("NO_SPEECH_DETECTED")) return apiError("NO_SPEECH", "没有听清楚，请再说一遍。", 422, traceId);
    if (message.includes("TENCENT_ASR_NOT_CONFIGURED")) return apiError("ASR_PROVIDER_UNAVAILABLE", "生产语音服务尚未配置。", 503, traceId);
    if (message.includes("BAILIAN_ASR_NOT_CONFIGURED")) return apiError("ASR_PROVIDER_UNAVAILABLE", "百炼语音服务尚未配置。", 503, traceId);
    if (message.includes("TENCENT_ASR_AUDIO_TOO_LARGE")) return apiError("AUDIO_TOO_LARGE", "本次录音过长，请控制在 30 秒内。", 413, traceId);
    if (message.includes("BAILIAN_ASR_AUDIO_TOO_LARGE")) return apiError("AUDIO_TOO_LARGE", "本次录音过长，请控制在 30 秒内。", 413, traceId);
    if (message.includes("ASR_AUDIO_FORMAT_UNSUPPORTED")) return apiError("AUDIO_TYPE_UNSUPPORTED", "暂不支持这种录音格式。", 415, traceId);
    if (message.includes("TIMEOUT") || message.includes("Timeout") || message.includes("aborted")) return apiError("ASR_TIMEOUT", "语音识别等待时间较长，请重试。", 504, traceId);
    return apiError("ASR_FAILED", "语音暂时没有识别成功，请重试或改用文字输入。", 503, traceId);
  } finally {
    await unlink(tempFile).catch(() => undefined);
  }
}

export async function GET(request: NextRequest) {
  const traceId = createTraceId();
  const demoMode = process.env.NEXT_PUBLIC_DEMO_MODE === "true";
  const auth = await getApiAuthContext(request);
  if (demoMode) {
    return apiOk({
      provider: speechProvider(),
      configured: true,
      maxDurationSeconds: 30,
      demo: true,
      serverTranscription: true,
    }, traceId);
  }
  if (!auth.supabase || !auth.profile) return apiError("UNAUTHENTICATED", "请先登录。", 401, traceId);
  return apiOk({ provider: speechProvider(), configured: true, maxDurationSeconds: 30 }, traceId);
}
