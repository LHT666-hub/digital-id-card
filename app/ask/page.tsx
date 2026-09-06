"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowUpRight,
  ChevronRight,
  BookOpen,
  Clock3,
  Camera,
  FileText,
  History,
  ImagePlus,
  Keyboard,
  LoaderCircle,
  Mic,
  Plus,
  Send,
  ShieldCheck,
  Stethoscope,
  Trash2,
  XCircle,
} from "lucide-react";
import { PhoneShell } from "@/components/PhoneShell";
import { CareSubjectSwitcher } from "@/components/CareSubjectSwitcher";
import { HoldToTalkButton } from "@/components/HoldToTalkButton";
import {
  DocumentImagePanel,
  type DocumentImageAttachment,
  type DocumentImagePanelHandle,
} from "@/components/DocumentImagePanel";
import { buildContextualQuestion } from "@/lib/assistant/conversationContext";
import {
  createConversation,
  getActiveConversationId,
  getConversation,
  saveConversation,
  setActiveConversationId,
} from "@/lib/assistant/clientConversation";

type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  source?: string;
  nextStep?: string;
  risk?: string;
  suggestDoctor?: boolean;
  attachment?: {
    type: "image";
    label: string;
    thumbnail?: string;
  };
  actions?: Array<{
    id: string;
    kind: "service" | "schedule" | "public_info" | "progress" | "emergency";
    label: string;
    description: string;
    href: string;
    requiresConfirmation: boolean;
  }>;
  citations?: Array<{
    index: number;
    title: string;
    sourceName: string;
    sourceUrl: string;
    reviewedAt: string;
  }>;
};

type AssistantActivity = {
  id: string;
  type:
    | "public_info_query"
    | "schedule_query"
    | "service_draft_prepared"
    | "safety_guidance"
    | "general_guidance";
  title: string;
  detail: string;
  badge: string;
  riskLevel: "low" | "medium" | "high" | "emergency";
  occurredAt: string;
  primaryAction: { label: string; href: string } | null;
};

type AssistantReplyPayload = {
  answer?: string;
  source?: string;
  nextStep?: string;
  riskLevel?: string;
  suggestDoctor?: boolean;
  category?: string;
  citations?: Message["citations"];
};

type AssistantResponsePayload = {
  data?: {
    reply?: AssistantReplyPayload;
    actions?: Message["actions"];
    activity?: AssistantActivity | null;
  };
  error?: { code?: string; message?: string };
};

const sourceLabels: Record<string, string> = {
  safety: "安全分流",
  agent: "Claw 服务编排",
  knowledge: "已审核公开信息",
  knowledge_kimi: "知识库与 AI 整理",
  knowledge_model: "知识库与 AI 整理",
  faq: "服务知识库",
  faq_kimi: "服务知识库与 AI 整理",
  faq_model: "服务知识库与 AI 整理",
  model: "AI 模型整理",
  kimi: "AI 通用整理",
  fallback: "安全兜底",
};
const DEMO_HISTORY_KEY = "jiayi-claw-demo-conversation-history";
const WELCOME_MESSAGE: Message = {
  id: "welcome",
  role: "assistant",
  text: "您好，直接告诉我您想办什么。我可以查已核验信息、整理预约或转诊诉求，并把下一步准备好给您确认。",
};

function retainDemoConversation(question: string, reply: { answer?: string; category?: string; riskLevel?: string }) {
  if (process.env.NEXT_PUBLIC_DEMO_MODE !== "true") return;
  try {
    const current = JSON.parse(sessionStorage.getItem(DEMO_HISTORY_KEY) ?? "[]") as unknown[];
    sessionStorage.setItem(
      DEMO_HISTORY_KEY,
      JSON.stringify([
        {
          id: crypto.randomUUID(),
          question,
          answer: reply.answer ?? null,
          category: reply.category ?? null,
          risk_level: reply.riskLevel ?? "low",
          created_at: new Date().toISOString(),
        },
        ...current,
      ].slice(0, 100)),
    );
  } catch {
    // Demo history is optional and never replaces production server storage.
  }
}

function buildImageQuestionContext(attachment: DocumentImageAttachment) {
  const analysis = attachment.analysis;
  if (!analysis) return "";
  return [
    "本轮用户上传了一张医疗相关图片。以下内容来自视觉模型对原图的结构化识别，只作为本轮图片上下文，不是医生诊断：",
    analysis.visibleText.length
      ? `图片可见文字：${analysis.visibleText.slice(0, 12).join("；")}`
      : "图片可见文字：未清晰识别到文字",
    analysis.plainSummary.length
      ? `图片整理摘要：${analysis.plainSummary.slice(0, 6).join("；")}`
      : "",
    analysis.uncertainItems.length
      ? `需要人工核对：${analysis.uncertainItems.slice(0, 6).join("；")}`
      : "",
    "回答时请结合用户本轮对这张图片的具体提问；看不清或无法确认的信息要明确说无法确认。",
  ].filter(Boolean).join("\n");
}

export default function AskPage() {
  const router = useRouter();
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<Message[]>([WELCOME_MESSAGE]);
  const [conversationId, setConversationId] = useState("");
  const [conversationHydrated, setConversationHydrated] = useState(false);
  const conversationCreatedAtRef = useRef(new Date().toISOString());
  const [loading, setLoading] = useState(false);
  const [loadingStage, setLoadingStage] = useState("正在理解您的问题…");
  const [inputMode, setInputMode] = useState<"text" | "voice">("text");
  const [attachmentOpen, setAttachmentOpen] = useState(false);
  const [documentAttachment, setDocumentAttachment] = useState<DocumentImageAttachment | null>(null);
  const [activities, setActivities] = useState<AssistantActivity[]>([]);
  const [activityOpen, setActivityOpen] = useState(false);
  const [activityLoading, setActivityLoading] = useState(true);
  const [clearingActivity, setClearingActivity] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const messageScrollRef = useRef<HTMLDivElement>(null);
  const documentRef = useRef<DocumentImagePanelHandle>(null);
  const loadingTimersRef = useRef<number[]>([]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requestedConversationId = params.get("conversation");
    const stored = getConversation(requestedConversationId ?? getActiveConversationId());
    const conversation = stored ?? createConversation(WELCOME_MESSAGE);
    setConversationId(conversation.id);
    setActiveConversationId(conversation.id);
    conversationCreatedAtRef.current = conversation.createdAt;
    setMessages(conversation.messages.length ? conversation.messages as Message[] : [WELCOME_MESSAGE]);
    setConversationHydrated(true);

    const initial = params.get("q");
    if (initial) setQuestion(initial);
    if (params.get("voice") === "1") setInputMode("voice");
    if (params.get("photo") === "1")
      window.setTimeout(() => documentRef.current?.openCamera(), 180);
  }, []);

  useEffect(() => {
    if (!conversationHydrated || !conversationId) return;
    const timer = window.setTimeout(() => {
      saveConversation({
        id: conversationId,
        title: "新对话",
        createdAt: conversationCreatedAtRef.current,
        updatedAt: new Date().toISOString(),
        messages,
      });
      setActiveConversationId(conversationId);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [conversationHydrated, conversationId, messages]);

  useEffect(() => () => loadingTimersRef.current.forEach((timer) => window.clearTimeout(timer)), []);

  useEffect(() => {
    let active = true;
    void fetch("/api/v1/assistant/session", { cache: "no-store" })
      .then(async (response) => {
        if (response.status === 401) return router.replace("/login");
        if (!response.ok) return;
        const payload = await response.json();
        if (active) setActivities(payload.data?.activities ?? []);
      })
      .catch(() => undefined)
      .finally(() => active && setActivityLoading(false));
    return () => {
      active = false;
    };
  }, [router]);

  useEffect(() => {
    const container = messageScrollRef.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  useEffect(() => {
    const viewport = window.visualViewport;
    const keepConversationVisible = () => window.requestAnimationFrame(() => {
      const container = messageScrollRef.current;
      if (container) container.scrollTop = container.scrollHeight;
    });
    viewport?.addEventListener("resize", keepConversationVisible);
    return () => viewport?.removeEventListener("resize", keepConversationVisible);
  }, []);

  function applyActivity(activity: AssistantActivity | null | undefined) {
    if (!activity) return;
    setActivities((items) => [
      activity,
      ...items.filter((item) => item.id !== activity.id),
    ].slice(0, 12));
  }

  function appendResolvedReply(text: string, payload: AssistantResponsePayload) {
    const reply = payload.data?.reply;
    if (!reply) throw new Error(payload.error?.message ?? "Claw 暂时无法回答");
    retainDemoConversation(text, reply);
    setMessages((items) => [
      ...items,
      {
        id: crypto.randomUUID(),
        role: "assistant",
        text: reply.answer ?? "已收到您的问题。",
        source: reply.source,
        nextStep: reply.nextStep,
        risk: reply.riskLevel,
        suggestDoctor: Boolean(reply.suggestDoctor),
        actions: payload.data?.actions ?? [],
        citations: reply.citations ?? [],
      },
    ]);
    applyActivity(payload.data?.activity);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const attachmentForTurn = documentAttachment;
    const text = question.trim();
    if (loading || attachmentForTurn?.loading) return;
    if (attachmentForTurn?.error) return;
    if (!text && !attachmentForTurn?.analysis) return;

    const displayText = text || "请帮我看看这张图片";
    const conversation = messages
      .filter((item) => item.id !== "welcome" && item.text.trim())
      .slice(-10)
      .map((item) => ({ role: item.role, content: item.text }));
    const contextualQuestion = buildContextualQuestion(displayText, conversation);
    const imageContext = attachmentForTurn ? buildImageQuestionContext(attachmentForTurn) : "";
    const requestQuestion = imageContext
      ? `${contextualQuestion}\n\n${imageContext}`.slice(0, 6000)
      : contextualQuestion;

    setQuestion("");
    documentRef.current?.clear();
    setMessages((items) => [
      ...items,
      {
        id: crypto.randomUUID(),
        role: "user",
        text: displayText,
        attachment: attachmentForTurn
          ? {
              type: "image",
              label: attachmentForTurn.name || "图片附件",
              thumbnail: attachmentForTurn.thumbnail || undefined,
            }
          : undefined,
      },
    ]);
    setLoading(true);
    setLoadingStage("正在理解您的问题…");
    loadingTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    loadingTimersRef.current = [
      window.setTimeout(() => setLoadingStage("正在选择知识库或基础模型…"), 650),
      window.setTimeout(() => setLoadingStage("正在生成回答…"), 2200),
    ];

    let streamedMessageId: string | null = null;
    try {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 45_000);
      const response = await fetch("/api/v1/assistant/stream", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream, application/json",
        },
        body: JSON.stringify({ question: requestQuestion, conversation }),
        signal: controller.signal,
      });
      const contentType = response.headers.get("content-type") ?? "";

      if (!contentType.includes("text/event-stream")) {
        window.clearTimeout(timeout);
        const payload = await response.json() as AssistantResponsePayload;
        if (response.status === 401) return router.replace("/login");
        if (payload.error?.code === "AI_CONSENT_REQUIRED") {
          setMessages((items) => [
            ...items,
            {
              id: crypto.randomUUID(),
              role: "assistant",
              text: payload.error?.message ?? "请先开启 AI 辅助整理授权。",
              actions: [
                {
                  id: "open-ai-consent",
                  kind: "public_info",
                  label: "管理 AI 授权",
                  description: "授权按当前服务对象单独记录，也可以随时撤回。",
                  href: "/privacy",
                  requiresConfirmation: false,
                },
              ],
            },
          ]);
          return;
        }
        if (!response.ok) throw new Error(payload.error?.message ?? "Claw 暂时无法回答");
        appendResolvedReply(displayText, payload);
        return;
      }

      if (!response.ok || !response.body) {
        window.clearTimeout(timeout);
        throw new Error("Claw 暂时无法开始生成回答");
      }

      streamedMessageId = crypto.randomUUID();
      const assistantId = streamedMessageId;
      setMessages((items) => [
        ...items,
        { id: assistantId, role: "assistant", text: "" },
      ]);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let sawFinal = false;

      const processEvent = (block: string) => {
        const lines = block.split(/\r?\n/);
        const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() ?? "message";
        const dataText = lines
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (!dataText) return;
        const payload = JSON.parse(dataText) as AssistantResponsePayload & { text?: string };

        if (eventName === "delta" && payload.text) {
          setLoadingStage("正在生成回答…");
          setMessages((items) => items.map((item) =>
            item.id === assistantId ? { ...item, text: `${item.text}${payload.text}` } : item,
          ));
          return;
        }
        if (eventName === "error") {
          throw new Error(payload.error?.message ?? "模型连接暂时没有成功，请重试。");
        }
        if (eventName === "final") {
          const reply = payload.data?.reply;
          if (!reply) throw new Error("回答生成完成，但返回格式不完整。请重试。");
          sawFinal = true;
          retainDemoConversation(displayText, reply);
          setMessages((items) => items.map((item) =>
            item.id === assistantId
              ? {
                  ...item,
                  text: reply.answer || item.text || "已收到您的问题。",
                  source: reply.source,
                  nextStep: reply.nextStep,
                  risk: reply.riskLevel,
                  suggestDoctor: Boolean(reply.suggestDoctor),
                  actions: payload.data?.actions ?? [],
                  citations: reply.citations ?? [],
                }
              : item,
          ));
          applyActivity(payload.data?.activity);
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          if (block.trim()) processEvent(block);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) processEvent(buffer);
      window.clearTimeout(timeout);
      if (!sawFinal) throw new Error("回答流意外结束，请重试。");
    } catch (error) {
      const errorText =
        error instanceof DOMException && error.name === "AbortError"
          ? "这次回答超过 45 秒，已自动停止。请重试。"
          : error instanceof Error
          ? error.message
          : "网络连接失败，请稍后重试。";
      if (streamedMessageId) {
        const failedId = streamedMessageId;
        setMessages((items) => items.map((item) =>
          item.id === failedId
            ? { ...item, text: item.text ? `${item.text}\n\n${errorText}` : errorText }
            : item,
        ));
      } else {
        setMessages((items) => [
          ...items,
          { id: crypto.randomUUID(), role: "assistant", text: errorText },
        ]);
      }
    } finally {
      loadingTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      loadingTimersRef.current = [];
      setLoading(false);
    }
  }

  async function clearActivity() {
    if (clearingActivity) return;
    setClearingActivity(true);
    try {
      const response = await fetch("/api/v1/assistant/session", {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("清除失败");
      setActivities([]);
      setActivityOpen(false);
    } finally {
      setClearingActivity(false);
    }
  }

  function activityTime(value: string) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "最近";
    return new Intl.DateTimeFormat("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  }

  const canSend = !loading
    && !documentAttachment?.loading
    && !documentAttachment?.error
    && Boolean(question.trim() || documentAttachment?.analysis);

  return (
    <PhoneShell contentMode="fixed">
      <div className="absolute inset-0 mx-auto flex min-h-0 w-full flex-col">
        <header className="ask-header flex shrink-0 items-center gap-3 border-b border-line/60 px-4 pb-3 pt-7">
          <button
            onClick={() => router.back()}
            aria-label="返回"
            className="ios-control flex h-11 w-11 items-center justify-center rounded-full text-navy"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div>
            <h1 className="page-title">问 Claw</h1>
          </div>
          <Link
            href={conversationId ? `/ask/history?conversation=${encodeURIComponent(conversationId)}` : "/ask/history"}
            aria-label="查看对话记录"
            className="ios-control ml-auto flex h-11 w-11 items-center justify-center rounded-full text-navy"
          >
            <History className="h-4 w-4" />
          </Link>
        </header>

        <div ref={messageScrollRef} className="phone-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-3">
          <div className="mt-3">
            <CareSubjectSwitcher compact />
          </div>
          {activityLoading ? (
            <div className="mt-4 h-[74px] animate-shimmer rounded-[24px]" />
          ) : activities.length ? (
            <section className="ios-material animate-in mt-4 overflow-hidden rounded-[26px]">
              <button
                type="button"
                aria-expanded={activityOpen}
                onClick={() => setActivityOpen((value) => !value)}
                className="ios-pressable flex w-full items-center gap-3 px-4 py-3.5 text-left"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-health-muted text-sage">
                  <History className="h-4.5 w-4.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[11px] font-semibold text-sage">继续上次服务</span>
                  <span className="mt-0.5 block truncate text-sm font-semibold text-navy">
                    {activities[0].title}
                  </span>
                </span>
                <span className="rounded-full bg-white/70 px-2.5 py-1 text-[10px] font-semibold text-navy/48">
                  {activities.length} 条轨迹
                </span>
                <ChevronRight
                  className={`h-4 w-4 text-navy/38 transition-transform duration-200 ${activityOpen ? "rotate-90" : ""}`}
                />
              </button>
              {activityOpen ? (
                <div className="border-t border-line/45 px-4 pb-3">
                  <div className="divide-y divide-line/45">
                    {activities.slice(0, 5).map((activity) => (
                      <div key={activity.id} className="flex gap-3 py-3.5">
                        <span
                          className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${activity.riskLevel === "emergency" ? "bg-risk-strong text-danger" : "bg-white/75 text-sage"}`}
                        >
                          {activity.riskLevel === "emergency" ? (
                            <AlertTriangle className="h-3.5 w-3.5" />
                          ) : (
                            <ShieldCheck className="h-3.5 w-3.5" />
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="truncate text-xs font-semibold text-navy">{activity.title}</span>
                            <span className="shrink-0 rounded-full bg-health-soft px-2 py-0.5 text-[9px] font-semibold text-sage">
                              {activity.badge}
                            </span>
                          </span>
                          <span className="mt-1 block text-[11px] leading-4 text-navy/48">{activity.detail}</span>
                          <span className="mt-1.5 flex items-center gap-1 text-[10px] text-navy/35">
                            <Clock3 className="h-3 w-3" />
                            {activityTime(activity.occurredAt)}
                          </span>
                        </span>
                        {activity.primaryAction ? (
                          <Link
                            href={activity.primaryAction.href}
                            aria-label={activity.primaryAction.label}
                            className="ios-pressable flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/70 text-navy"
                          >
                            <ArrowUpRight className="h-3.5 w-3.5" />
                          </Link>
                        ) : null}
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center justify-between border-t border-line/45 pt-3 text-[10px] text-navy/38">
                    <span>服务轨迹保留 30 天，对话记录可单独管理</span>
                    <button
                      type="button"
                      disabled={clearingActivity}
                      onClick={() => void clearActivity()}
                      className="ios-pressable flex min-h-0 items-center gap-1 rounded-full px-2 py-1.5 font-semibold text-danger disabled:opacity-40"
                    >
                      <Trash2 className="h-3 w-3" />
                      清除
                    </button>
                  </div>
                </div>
              ) : null}
            </section>
          ) : (
            <div className="mt-4 flex items-center gap-2 px-1 text-[11px] leading-5 text-navy/42">
              <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-sage" />
              当前对话会在本次浏览会话中保留；办理动作会形成独立服务轨迹
            </div>
          )}

          <div className="mt-4 rounded-[22px] border border-danger/15 bg-risk-soft p-3 text-xs leading-5 text-danger">
            <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
            胸痛、呼吸困难、意识不清或大出血请立即拨打 120。
          </div>

          <div className="mt-4 flex-1 space-y-3">
            {messages.map((item) => (
              <div
                key={item.id}
                className={`message-enter flex ${item.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[86%] rounded-[24px] px-4 py-3 text-sm leading-6 shadow-[0_10px_26px_rgba(16,42,67,0.07)] ${item.role === "user" ? "rounded-br-[8px] bg-navy text-white" : "rounded-bl-[8px] border border-line/60 bg-surface-card text-navy"}`}
                >
                  {item.attachment ? (
                    <div className="mb-2 overflow-hidden rounded-[16px] bg-white/10">
                      {item.attachment.thumbnail ? (
                        <Image
                          src={item.attachment.thumbnail}
                          width={220}
                          height={160}
                          unoptimized
                          alt={item.attachment.label}
                          className="max-h-40 w-full object-cover"
                        />
                      ) : (
                        <div className="flex items-center gap-2 px-3 py-2 text-xs opacity-75">
                          <ImagePlus className="h-4 w-4" />
                          {item.attachment.label}
                        </div>
                      )}
                    </div>
                  ) : null}
                  <p className="whitespace-pre-wrap">{item.text}</p>
                  {item.nextStep ? (
                    <p className="mt-2 border-t border-line/50 pt-2 text-xs opacity-70">
                      下一步：{item.nextStep}
                    </p>
                  ) : null}
                  {item.source ? (
                    <p className="mt-2 text-[11px] opacity-50">
                      回答依据：{sourceLabels[item.source] ?? item.source}
                    </p>
                  ) : null}
                  {item.citations?.length ? (
                    <div className="mt-3 space-y-2 border-t border-line/50 pt-3">
                      <p className="text-[11px] font-semibold opacity-65">可核验依据</p>
                      {item.citations.map((citation) => (
                        <a
                          key={`${citation.index}-${citation.sourceUrl}`}
                          href={citation.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center gap-2 rounded-[16px] bg-health-soft px-3 py-2.5 text-left text-navy"
                        >
                          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white text-[11px] font-bold text-sage">
                            {citation.index}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs font-semibold">{citation.title}</span>
                            <span className="mt-0.5 block truncate text-[10px] text-navy/48">
                              {citation.sourceName} · 核验于 {new Date(citation.reviewedAt).toLocaleDateString("zh-CN")}
                            </span>
                          </span>
                          <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-sage" />
                        </a>
                      ))}
                    </div>
                  ) : null}
                  {item.actions?.length ? (
                    <div className="mt-3 space-y-2 border-t border-line/50 pt-3">
                      {item.actions.map((action, index) => (
                        <Link
                          key={action.id}
                          href={action.href}
                          className={`flex items-center gap-3 rounded-[18px] px-3 py-3 ${action.kind === "emergency" ? "bg-danger text-white" : index === 0 ? "bg-health-soft text-navy" : "border border-line/60 bg-white/70 text-navy"}`}
                        >
                          <span
                            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${action.kind === "emergency" ? "bg-white/15" : "bg-white text-sage"}`}
                          >
                            <Stethoscope className="h-4 w-4" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-xs font-semibold">{action.label}</span>
                            <span
                              className={`mt-0.5 block text-[11px] leading-4 ${action.kind === "emergency" ? "text-white/75" : "text-navy/48"}`}
                            >
                              {action.description}
                            </span>
                            {action.requiresConfirmation ? (
                              <span className="mt-1 block text-[10px] font-semibold text-sage">
                                需您核对确认后提交
                              </span>
                            ) : null}
                          </span>
                          <ChevronRight className="h-4 w-4 shrink-0 opacity-45" />
                        </Link>
                      ))}
                    </div>
                  ) : item.suggestDoctor ? (
                    <Link
                      href="/appointments"
                      className="mt-3 flex items-center justify-center gap-1 rounded-full bg-health-soft px-3 py-2 text-xs font-semibold text-sage"
                    >
                      <Stethoscope className="h-3.5 w-3.5" />
                      整理后发起服务申请
                    </Link>
                  ) : null}
                </div>
              </div>
            ))}
            {loading ? (
              <div className="flex items-center gap-2 text-sm text-navy/45">
                <span className="h-2 w-2 animate-pulse rounded-full bg-sage" />
                {loadingStage}
              </div>
            ) : null}
            <div ref={endRef} />
          </div>

          {messages.length === 1 ? (
            <div className="my-4 grid grid-cols-2 gap-2">
              {[
                "今天有哪些医生坐班？",
                "如何预约家庭医生？",
                "社区最近有什么活动？",
                "帮我整理复诊要问的问题",
              ].map((item) => (
                <button
                  key={item}
                  onClick={() => setQuestion(item)}
                  className="rounded-[22px] border border-line bg-white p-3 text-left text-xs leading-5 text-navy/65 shadow-[0_10px_24px_rgba(16,42,67,0.05)]"
                >
                  <BookOpen className="mb-2 h-4 w-4 text-sage" />
                  {item}
                </button>
              ))}
            </div>
          ) : null}
          <DocumentImagePanel ref={documentRef} onChange={setDocumentAttachment} />
        </div>

        {attachmentOpen ? (
          <>
            <button
              type="button"
              aria-label="关闭附件菜单"
              onClick={() => setAttachmentOpen(false)}
              className="absolute inset-0 z-20 min-h-0 bg-navy/8 backdrop-blur-[1px]"
            />
            <section className="ios-material absolute inset-x-3 bottom-[84px] z-30 rounded-[28px] p-3 shadow-[0_24px_54px_rgba(16,42,67,0.2)]">
              <div className="grid grid-cols-4 gap-2">
                {[
                  {
                    label: "拍照",
                    icon: Camera,
                    action: () => documentRef.current?.openCamera(),
                  },
                  {
                    label: "相册",
                    icon: ImagePlus,
                    action: () => documentRef.current?.openLibrary(),
                  },
                  {
                    label: "文件",
                    icon: FileText,
                    action: () => documentRef.current?.openFile(),
                  },
                  {
                    label: "录音",
                    icon: Mic,
                    action: () => setInputMode("voice"),
                  },
                ].map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.label}
                      type="button"
                      onClick={() => {
                        setAttachmentOpen(false);
                        item.action();
                      }}
                      className="ios-pressable flex min-w-0 flex-col items-center gap-2 rounded-[20px] px-1 py-3 text-[11px] font-semibold text-navy hover:bg-health-soft"
                    >
                      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-health-muted text-sage">
                        <Icon className="h-5 w-5" />
                      </span>
                      {item.label}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1 text-center text-[10px] text-navy/38">
                文件仅用于本次识别，原件不写入居民档案
              </p>
            </section>
          </>
        ) : null}

        <form
          onSubmit={submit}
          className="ask-composer mx-3 mt-2 flex shrink-0 flex-col gap-2 rounded-[28px] border border-white/70 bg-surface-nav/92 p-2 shadow-[0_14px_34px_rgba(16,42,67,0.13)] backdrop-blur-2xl"
        >
          {documentAttachment ? (
            <div className="flex items-center gap-3 rounded-[20px] border border-line/60 bg-white/80 p-2 pr-2.5">
              {documentAttachment.previewUrl ? (
                <Image
                  src={documentAttachment.thumbnail || documentAttachment.previewUrl}
                  width={52}
                  height={52}
                  unoptimized
                  alt="待发送图片"
                  className="h-13 w-13 shrink-0 rounded-[14px] object-cover"
                />
              ) : (
                <span className="flex h-13 w-13 shrink-0 items-center justify-center rounded-[14px] bg-health-muted text-sage">
                  <ImagePlus className="h-5 w-5" />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-semibold text-navy">{documentAttachment.name || "图片附件"}</p>
                <p className={`mt-0.5 text-[10px] ${documentAttachment.error ? "text-danger" : "text-navy/45"}`}>
                  {documentAttachment.loading ? "正在识别图片，可继续打字或录音…" : documentAttachment.error ? documentAttachment.error : "图片已就绪，可继续补充问题后发送"}
                </p>
                {documentAttachment.consentRequired ? (
                  <Link href="/privacy" className="mt-1 inline-block text-[10px] font-semibold text-sage underline underline-offset-2">
                    管理图片识别授权
                  </Link>
                ) : null}
              </div>
              {documentAttachment.loading ? <LoaderCircle className="h-4 w-4 animate-spin text-sage" /> : null}
              <button
                type="button"
                onClick={() => documentRef.current?.clear()}
                aria-label="移除图片"
                className="ios-pressable flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-input text-navy/45"
              >
                <XCircle className="h-4 w-4" />
              </button>
            </div>
          ) : null}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setInputMode((mode) => mode === "text" ? "voice" : "text")}
              aria-label={inputMode === "text" ? "切换到语音输入" : "切换到键盘输入"}
              className="ios-pressable flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-health-muted text-sage"
            >
              {inputMode === "text" ? <Mic className="h-5 w-5" /> : <Keyboard className="h-5 w-5" />}
            </button>
            <button
              type="button"
              onClick={() => setAttachmentOpen((open) => !open)}
              aria-label={attachmentOpen ? "关闭附件菜单" : "添加附件"}
              aria-expanded={attachmentOpen}
              className="ios-pressable flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[#EDF3F7] text-[#315B7D]"
            >
              <Plus className={`h-5 w-5 transition-transform ${attachmentOpen ? "rotate-45" : ""}`} />
            </button>
            {inputMode === "voice" ? (
              <HoldToTalkButton
                disabled={loading}
                onFallback={() =>
                  setMessages((items) => [
                    ...items,
                    {
                      id: crypto.randomUUID(),
                      role: "assistant",
                      text: "当前浏览器没有开放语音识别能力。请先用键盘输入，或在微信小程序中按住说话。",
                    },
                  ])
                }
                onTranscript={(transcript) => {
                  setQuestion((current) => current.trim() ? `${current.trim()} ${transcript}` : transcript);
                  setInputMode("text");
                }}
              />
            ) : (
              <>
                <input
                  value={question}
                  onChange={(event) => setQuestion(event.target.value)}
                  onFocus={() => window.requestAnimationFrame(() => {
                    const container = messageScrollRef.current;
                    if (container) container.scrollTop = container.scrollHeight;
                  })}
                  placeholder={documentAttachment ? "补充你想问这张图片的内容" : "问服务、排班、活动或准备材料"}
                  className="h-12 min-w-0 flex-1 rounded-full border border-line bg-surface-card px-4 text-sm outline-none focus:border-sage"
                />
                <button
                  disabled={!canSend}
                  aria-label="发送"
                  className="ios-pressable flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-navy text-white shadow-[0_10px_22px_rgba(16,42,67,0.2)] disabled:opacity-40"
                >
                  <Send className="h-4 w-4" />
                </button>
              </>
            )}
          </div>
        </form>
        <div className="shrink-0 pb-[max(12px,env(safe-area-inset-bottom))]" />
      </div>
    </PhoneShell>
  );
}
