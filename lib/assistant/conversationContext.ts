export type AssistantConversationTurn = {
  role: "user" | "assistant";
  content: string;
};

export function trimConversationTurns(
  turns: AssistantConversationTurn[] | undefined,
  maxTurns = 10,
) {
  return (turns ?? [])
    .filter((turn) => turn.content.trim())
    .slice(-maxTurns)
    .map((turn) => ({
      role: turn.role,
      content: turn.content.trim().slice(0, 2400),
    }));
}

const followUpPattern = /^(?:那|那么|这个|这个呢|它|这个情况|这种情况|还有|然后|继续|刚才|上面|前面|那边|这里|这样|为什么|怎么|呢|周[一二三四五六日天]|几点|多久|可以吗|行吗)/;

export function buildContextualQuestion(
  question: string,
  turns: AssistantConversationTurn[] | undefined,
) {
  const current = question.trim();
  const recent = trimConversationTurns(turns, 8);
  if (!recent.length) return current;

  const lastUser = [...recent].reverse().find((turn) => turn.role === "user");
  if (!lastUser) return current;

  const compact = current.replace(/\s+/g, "");
  const looksLikeFollowUp = compact.length <= 18 || followUpPattern.test(compact);
  if (!looksLikeFollowUp) return current;

  return `${lastUser.content}\n追问：${current}`;
}
