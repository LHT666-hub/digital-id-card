import { describe, expect, it } from "vitest";
import { buildContextualQuestion, trimConversationTurns } from "@/lib/assistant/conversationContext";

describe("assistant conversation context", () => {
  it("keeps an explicit standalone question unchanged", () => {
    expect(buildContextualQuestion("帮我查一下最新医保政策", [
      { role: "user", content: "南桥预防接种几点？" },
      { role: "assistant", content: "周一到周四和周六有接种时段。" },
    ])).toBe("帮我查一下最新医保政策");
  });

  it("attaches the previous user turn to a short follow-up", () => {
    expect(buildContextualQuestion("那周六呢？", [
      { role: "user", content: "南桥预防接种几点？" },
      { role: "assistant", content: "工作日有接种时段。" },
    ])).toBe("南桥预防接种几点？\n追问：那周六呢？");
  });

  it("bounds the amount of context sent upstream", () => {
    const turns = Array.from({ length: 15 }, (_, index) => ({
      role: index % 2 ? "assistant" as const : "user" as const,
      content: `turn-${index}`,
    }));
    expect(trimConversationTurns(turns, 4).map((turn) => turn.content)).toEqual([
      "turn-11",
      "turn-12",
      "turn-13",
      "turn-14",
    ]);
  });
});
