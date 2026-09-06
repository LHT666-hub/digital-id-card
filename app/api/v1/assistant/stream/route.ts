import { NextRequest } from "next/server";
import { z } from "zod";
import { POST as resolvedAssistantPost } from "@/app/api/v1/assistant/messages/route";
import { streamBailianGeneralAnswer } from "@/lib/ai/bailianStream";
import { buildAssistantActions } from "@/lib/assistant/actions";
import {
  buildAssistantActivity,
  presentAssistantActivity,
} from "@/lib/assistant/activity";
import {
  buildContextualQuestion,
  type AssistantConversationTurn,
} from "@/lib/assistant/conversationContext";
import { requiresVerifiedCurrentInfo } from "@/lib/assistant/verifiedCurrentInfo";
import { buildAgentReply, inferServiceRequestFromQuestion } from "@/lib/agent";
import { resolveCareSubject } from "@/lib/careSubjects";
import { getResidentCareAccess } from "@/lib/db/carePlatform";
import { getGreetingReply, getGuardrailReply } from "@/lib/faq";
import { buildMemoryContext, formatMemoryContextForPrompt } from "@/lib/memory";
import { CURRENT_POLICY_VERSION } from "@/lib/policies";
import { shouldSearchInstitutionalKnowledge } from "@/lib/rag/search";
import { getApiAuthContext } from "@/lib/supabase/server-auth";
import type { AskReply } from "@/lib/types";

export const runtime = "nodejs";

const conversationTurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(2400),
});

const inputSchema = z.object({
  question: z.string().trim().min(1).max(6000),
  conversation: z.array(conversationTurnSchema).max(12).optional(),
  residentId: z.string().uuid().optional(),
  serviceRequest: z.unknown().nullable().optional(),
  sourceContext: z.object({ type: z.literal("content"), id: z.string().uuid() }).optional(),
});

function sseEvent(event: string, payload: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

async function delegateToResolvedPipeline(
  request: NextRequest,
  body: z.infer<typeof inputSchema>,
) {
  const contextualQuestion = buildContextualQuestion(
    body.question,
    body.conversation,
  ).slice(0, 3000);
  const forwarded = new NextRequest(
    request.url.replace(/\/stream(?:\?.*)?$/, "/messages"),
    {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify({
        question: contextualQuestion,
        residentId: body.residentId,
        serviceRequest: body.serviceRequest,
        sourceContext: body.sourceContext,
      }),
    },
  );
  return resolvedAssistantPost(forwarded);
}

function shouldUseResolvedPipeline(
  question: string,
  conversation: AssistantConversationTurn[] | undefined,
) {
  const contextualQuestion = buildContextualQuestion(question, conversation);
  if (getGuardrailReply(contextualQuestion) || getGreetingReply(question)) return true;
  if (requiresVerifiedCurrentInfo(contextualQuestion)) return true;
  if (shouldSearchInstitutionalKnowledge(contextualQuestion)) return true;
  return Boolean(
    buildAgentReply(
      contextualQuestion,
      inferServiceRequestFromQuestion(contextualQuestion),
    ),
  );
}

function generalReply(question: string, result: { answer: string; usedWebSearch: boolean }): AskReply {
  const personalHealthQuestion =
    /(?:我|我的|最近|这几天|一直).{0,18}(?:血压|血糖|疼|痛|晕|咳|不舒服|症状|药)/.test(
      question,
    );
  return {
    answer: result.answer,
    nextStep: result.usedWebSearch
      ? "联网结果用于补充公开信息；涉及本地排班、号源、库存或个人诊疗，请以机构已审核信息和医生判断为准。"
      : "如果涉及您个人的症状、用药或检查结果，可以继续补充具体情况；需要诊疗判断时请联系家庭医生。",
    suggestDoctor: personalHealthQuestion,
    riskLevel: "low",
    category: result.usedWebSearch ? "联网问答" : "通用问答",
    source: "model",
  };
}

function streamGeneralWithoutPersistence(
  request: NextRequest,
  question: string,
  conversation: AssistantConversationTurn[] | undefined,
) {
  const encoder = new TextEncoder();
  const inferredServiceRequest = inferServiceRequestFromQuestion(question);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const emit = (event: string, payload: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(sseEvent(event, payload)));
      };
      const close = () => {
        if (closed) return;
        closed = true;
        controller.close();
      };

      void (async () => {
        try {
          emit("start", { model: "bailian", mode: "stream", persisted: false });
          const result = await streamBailianGeneralAnswer({
            question,
            conversation,
            signal: request.signal,
            onDelta: (text) => emit("delta", { text }),
          });
          const reply = generalReply(question, result);
          const actions = buildAssistantActions({
            question,
            reply,
            serviceRequest: inferredServiceRequest,
          });
          emit("final", {
            data: {
              reply,
              actions,
              activity: null,
              draft: inferredServiceRequest,
              careSubject: null,
              writePerformed: false,
              rawTranscriptStored: false,
              webSearchUsed: result.usedWebSearch,
              model: result.model,
              persisted: false,
            },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Claw 暂时无法回答";
          emit("error", {
            error: {
              code: message.includes("NOT_CONFIGURED")
                ? "AI_NOT_CONFIGURED"
                : "ASSISTANT_STREAM_FAILED",
              message: message.includes("NOT_CONFIGURED")
                ? "百炼模型尚未正确配置，请检查 DASHSCOPE_API_KEY。"
                : "模型连接暂时没有成功，请重试。",
            },
          });
        } finally {
          close();
        }
      })();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

export async function POST(request: NextRequest) {
  const parsed = inputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: { code: "INVALID_MESSAGE", message: "请输入要咨询的问题。" } },
      { status: 400 },
    );
  }

  const body = parsed.data;
  if (body.sourceContext || shouldUseResolvedPipeline(body.question, body.conversation)) {
    return delegateToResolvedPipeline(request, body);
  }

  const auth = await getApiAuthContext(request);
  if (!auth.supabase || !auth.profile) {
    if (process.env.NEXT_PUBLIC_DEMO_MODE === "true") {
      return streamGeneralWithoutPersistence(request, body.question, body.conversation);
    }
    return delegateToResolvedPipeline(request, body);
  }

  const careSubject = await resolveCareSubject(
    request,
    auth.profile,
    auth.supabase,
    body.residentId ?? null,
  ).catch(() => null);
  if (!careSubject) return delegateToResolvedPipeline(request, body);

  const [careState, consentResult] = await Promise.all([
    getResidentCareAccess(careSubject.residentId, auth.supabase),
    auth.supabase
      .from("consents")
      .select("granted")
      .eq("user_id", auth.profile.id)
      .eq("resident_id", careSubject.residentId)
      .eq("scope", "ai_processing")
      .eq("policy_version", CURRENT_POLICY_VERSION)
      .maybeSingle(),
  ]);
  if (
    !careState.access.canSubmitService ||
    consentResult.error ||
    !consentResult.data?.granted
  ) {
    return delegateToResolvedPipeline(request, body);
  }

  let memoryText = "";
  if (auth.profile.organization_id) {
    try {
      const memory = await Promise.race([
        buildMemoryContext({
          residentId: careSubject.residentId,
          organizationId: auth.profile.organization_id,
          maxTokens: 1200,
          supabase: auth.supabase,
        }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 700)),
      ]);
      if (memory) memoryText = formatMemoryContextForPrompt(memory);
    } catch {
      // Memory is optional; it must never delay a normal answer.
    }
  }

  const encoder = new TextEncoder();
  const question = body.question;
  const inferredServiceRequest = inferServiceRequestFromQuestion(question);
  const { supabase } = auth;
  const clientPlatform =
    request.headers.get("x-client-platform") === "weapp" ? "wechat" : "web";

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const emit = (event: string, payload: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(sseEvent(event, payload)));
      };
      const close = () => {
        if (closed) return;
        closed = true;
        controller.close();
      };

      void (async () => {
        try {
          emit("start", { model: "bailian", mode: "stream" });
          const result = await streamBailianGeneralAnswer({
            question,
            conversation: body.conversation,
            memoryText: memoryText || undefined,
            signal: request.signal,
            onDelta: (text) => emit("delta", { text }),
          });

          const reply = generalReply(question, result);
          const actions = buildAssistantActions({
            question,
            reply,
            serviceRequest: inferredServiceRequest,
          });
          const activityDescriptor = buildAssistantActivity({
            reply,
            actions,
            serviceRequest: inferredServiceRequest,
            skillIds: [],
          });

          let activity = null;
          try {
            const { data, error } = await supabase.rpc(
              "record_assistant_activity",
              {
                p_resident_id: careSubject.residentId,
                p_activity_type: activityDescriptor.activityType,
                p_service_type: activityDescriptor.serviceType,
                p_risk_level: activityDescriptor.riskLevel,
                p_source: activityDescriptor.source,
                p_skill_ids: activityDescriptor.skillIds,
                p_knowledge_refs: activityDescriptor.knowledgeRefs,
                p_action_kinds: activityDescriptor.actionKinds,
                p_trace_id: crypto.randomUUID(),
                p_channel: clientPlatform,
              },
            );
            if (!error && data) {
              const recorded = data as {
                activityId: string;
                occurredAt: string;
              };
              activity = presentAssistantActivity({
                id: recorded.activityId,
                activity_type: activityDescriptor.activityType,
                service_type: activityDescriptor.serviceType,
                risk_level: activityDescriptor.riskLevel,
                created_at: recorded.occurredAt,
              });
            }
          } catch {
            // Activity logging is best-effort and must not break chat.
          }

          emit("final", {
            data: {
              reply,
              actions,
              activity,
              draft: inferredServiceRequest,
              careSubject: careSubject.selected,
              writePerformed: false,
              rawTranscriptStored: false,
              webSearchUsed: result.usedWebSearch,
              model: result.model,
            },
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Claw 暂时无法回答";
          emit("error", {
            error: {
              code: message.includes("NOT_CONFIGURED")
                ? "AI_NOT_CONFIGURED"
                : "ASSISTANT_STREAM_FAILED",
              message: message.includes("NOT_CONFIGURED")
                ? "百炼模型尚未正确配置，请检查 DASHSCOPE_API_KEY。"
                : "模型连接暂时没有成功，请重试。",
            },
          });
        } finally {
          close();
        }
      })();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
