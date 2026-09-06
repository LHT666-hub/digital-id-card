"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ChevronRight, MessageCircle, ShieldCheck, Trash2 } from "lucide-react";
import { BackHeader } from "@/components/BackHeader";
import { PhoneShell } from "@/components/PhoneShell";
import { SectionCard } from "@/components/SectionCard";
import {
  clearSessionConversations,
  listSessionConversations,
  type ClientConversation,
} from "@/lib/assistant/clientConversation";

type HistoryItem = {
  id: string;
  question: string;
  answer: string | null;
  category: string | null;
  risk_level: "low" | "medium" | "high" | "emergency" | null;
  created_at: string;
};

const DEMO_HISTORY_KEY = "jiayi-claw-demo-conversation-history";

function readDemoItems() {
  try {
    return JSON.parse(sessionStorage.getItem(DEMO_HISTORY_KEY) ?? "[]") as HistoryItem[];
  } catch {
    return [];
  }
}

function conversationPreview(conversation: ClientConversation) {
  return [...conversation.messages]
    .reverse()
    .find((message) => message.role === "assistant" && message.id !== "welcome" && message.text.trim())
    ?.text.trim()
    .slice(0, 100) ?? "继续这段对话";
}

function conversationTurnCount(conversation: ClientConversation) {
  return conversation.messages.filter((message) => message.role === "user").length;
}

export default function AskHistoryPage() {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [sessionConversations, setSessionConversations] = useState<ClientConversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [demo, setDemo] = useState(false);
  const [retentionEnabled, setRetentionEnabled] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setSessionConversations(listSessionConversations());
    const response = await fetch("/api/v1/assistant/history", { cache: "no-store" });
    const payload = await response.json();
    if (response.ok) {
      const isDemo = Boolean(payload.data.demo);
      setDemo(isDemo);
      setRetentionEnabled(payload.data.retentionEnabled !== false);
      setItems(isDemo ? readDemoItems() : (payload.data.items ?? []));
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function clear() {
    if (!window.confirm("清除全部 Claw 对话记录？服务申请和审计轨迹不会被删除。")) return;
    clearSessionConversations();
    if (demo) sessionStorage.removeItem(DEMO_HISTORY_KEY);
    else if (retentionEnabled) await fetch("/api/v1/assistant/history", { method: "DELETE" });
    setSessionConversations([]);
    setItems([]);
  }

  const hasAnyHistory = sessionConversations.length > 0 || items.length > 0;

  return (
    <PhoneShell>
      <main className="space-y-5 px-4 pb-8">
        <BackHeader title="对话记录" subtitle="同一段对话可连续多轮，返回后仍可继续" />
        <div className="flex items-center justify-between rounded-[22px] bg-health-soft px-4 py-3 text-xs text-navy/60">
          <span className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-sage" />
            {retentionEnabled
              ? "当前浏览会话和已开启的账号记录会分开保存"
              : "当前对话仅保留在本次浏览会话，不写入长期健康档案"}
          </span>
          {hasAnyHistory ? (
            <button onClick={() => void clear()} className="flex items-center gap-1 font-semibold text-danger">
              <Trash2 className="h-3.5 w-3.5" />清除
            </button>
          ) : null}
        </div>

        {sessionConversations.length ? (
          <section className="space-y-3">
            <div className="flex items-end justify-between px-1">
              <div>
                <p className="text-sm font-semibold text-navy">本次浏览会话</p>
                <p className="mt-1 text-[11px] text-navy/42">点开任意一段，会恢复这段对话的全部多轮上下文</p>
              </div>
            </div>
            {sessionConversations.map((conversation) => (
              <Link
                key={conversation.id}
                href={`/ask?conversation=${encodeURIComponent(conversation.id)}`}
                className="ios-material flex items-center gap-3 rounded-[26px] p-4"
              >
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-health-muted text-sage">
                  <MessageCircle className="h-5 w-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-navy">{conversation.title}</span>
                  <span className="mt-1 line-clamp-2 block text-xs leading-5 text-navy/52">{conversationPreview(conversation)}</span>
                  <span className="mt-2 block text-[10px] text-navy/35">
                    {conversationTurnCount(conversation)} 轮 · {new Date(conversation.updatedAt).toLocaleString("zh-CN")}
                  </span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-navy/30" />
              </Link>
            ))}
          </section>
        ) : null}

        {loading ? (
          <div className="h-28 animate-shimmer rounded-[26px]" />
        ) : !retentionEnabled ? (
          sessionConversations.length ? null : (
            <SectionCard>
              <p className="text-sm font-semibold text-navy">还没有本次会话记录</p>
              <p className="mt-2 text-xs leading-5 text-navy/55">开始聊天后，当前对话会在本浏览会话内保留；离开问答页再返回不会清空。</p>
              <Link href="/ask" className="mt-4 inline-flex rounded-full bg-navy px-5 py-2.5 text-sm font-semibold text-white">去问 Claw</Link>
            </SectionCard>
          )
        ) : items.length ? (
          <section className="space-y-3">
            <p className="px-1 text-sm font-semibold text-navy">账号历史记录</p>
            {items.map((item) => (
              <article key={item.id} className="ios-material rounded-[26px] p-4">
                <p className="text-sm font-semibold leading-6 text-navy">{item.question}</p>
                {item.answer ? <p className="mt-2 line-clamp-4 text-sm leading-6 text-navy/62">{item.answer}</p> : null}
                <div className="mt-3 flex items-center justify-between text-[11px] text-navy/38">
                  <span>{item.category ?? "Claw 对话"}</span>
                  <time>{new Date(item.created_at).toLocaleString("zh-CN")}</time>
                </div>
              </article>
            ))}
          </section>
        ) : sessionConversations.length ? null : (
          <SectionCard>
            <div className="py-5 text-center">
              <MessageCircle className="mx-auto h-7 w-7 text-sage" />
              <p className="mt-3 text-sm font-semibold text-navy">还没有对话记录</p>
              <Link href="/ask" className="mt-4 inline-flex rounded-full bg-navy px-5 py-2.5 text-sm font-semibold text-white">去问 Claw</Link>
            </div>
          </SectionCard>
        )}
      </main>
    </PhoneShell>
  );
}
