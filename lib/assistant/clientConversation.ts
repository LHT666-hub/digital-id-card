export type ClientConversationAction = {
  id: string;
  kind: "service" | "schedule" | "public_info" | "progress" | "emergency";
  label: string;
  description: string;
  href: string;
  requiresConfirmation: boolean;
};

export type ClientConversationCitation = {
  index: number;
  title: string;
  sourceName: string;
  sourceUrl: string;
  reviewedAt: string;
};

export type ClientConversationMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  source?: string;
  nextStep?: string;
  risk?: string;
  suggestDoctor?: boolean;
  actions?: ClientConversationAction[];
  citations?: ClientConversationCitation[];
  attachment?: {
    type: "image";
    label: string;
    thumbnail?: string;
  };
};

export type ClientConversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ClientConversationMessage[];
};

const STORE_KEY = "jiayi-claw-session-conversations-v2";
const ACTIVE_KEY = "jiayi-claw-active-conversation-v2";
const MAX_CONVERSATIONS = 20;
const MAX_MESSAGES = 80;
const DEFAULT_WELCOME_MESSAGE: ClientConversationMessage = {
  id: "welcome",
  role: "assistant",
  text: "您好，直接告诉我您想办什么。我可以查已核验信息、整理预约或转诊诉求，并把下一步准备好给您确认。",
};

function hasSessionStorage() {
  return typeof window !== "undefined" && typeof window.sessionStorage !== "undefined";
}

function readStore(): ClientConversation[] {
  if (!hasSessionStorage()) return [];
  try {
    const parsed = JSON.parse(sessionStorage.getItem(STORE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStore(items: ClientConversation[]) {
  if (!hasSessionStorage()) return;
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(items.slice(0, MAX_CONVERSATIONS)));
  } catch {
    // Session persistence is best-effort. A full storage quota must never break chat.
  }
}

export function getConversation(id: string | null | undefined) {
  if (!id) return null;
  return readStore().find((item) => item.id === id) ?? null;
}

export function listSessionConversations() {
  return readStore().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getActiveConversationId() {
  if (!hasSessionStorage()) return null;
  return sessionStorage.getItem(ACTIVE_KEY);
}

export function setActiveConversationId(id: string) {
  if (!hasSessionStorage()) return;
  sessionStorage.setItem(ACTIVE_KEY, id);
}

export function createConversation(
  welcomeMessage: ClientConversationMessage = DEFAULT_WELCOME_MESSAGE,
): ClientConversation {
  const now = new Date().toISOString();
  const conversation: ClientConversation = {
    id: crypto.randomUUID(),
    title: "新对话",
    createdAt: now,
    updatedAt: now,
    messages: [{ ...welcomeMessage }],
  };
  saveConversation(conversation);
  setActiveConversationId(conversation.id);
  return conversation;
}

export function saveConversation(conversation: ClientConversation) {
  const firstUser = conversation.messages.find((item) => item.role === "user" && item.text.trim());
  const title = firstUser?.text.trim().slice(0, 34) || conversation.title || "新对话";
  const next: ClientConversation = {
    ...conversation,
    title,
    updatedAt: new Date().toISOString(),
    messages: conversation.messages.slice(-MAX_MESSAGES),
  };
  const current = readStore().filter((item) => item.id !== next.id);
  writeStore([next, ...current]);
  return next;
}

export function deleteSessionConversation(id: string) {
  writeStore(readStore().filter((item) => item.id !== id));
  if (getActiveConversationId() === id && hasSessionStorage()) {
    sessionStorage.removeItem(ACTIVE_KEY);
  }
}

export function clearSessionConversations() {
  if (!hasSessionStorage()) return;
  sessionStorage.removeItem(STORE_KEY);
  sessionStorage.removeItem(ACTIVE_KEY);
}
