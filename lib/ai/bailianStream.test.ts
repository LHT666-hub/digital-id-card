import { describe, expect, it } from "vitest";
import { shouldUsePublicWebSearch } from "@/lib/ai/bailianStream";

describe("Bailian web search routing", () => {
  it("requires web search for explicit and fresh public-information questions", () => {
    expect(shouldUsePublicWebSearch("帮我查一下最新医保政策")).toBe(true);
    expect(shouldUsePublicWebSearch("今年医保政策有什么更新？")).toBe(true);
    expect(shouldUsePublicWebSearch("联网搜索一下上海最新医保消息")).toBe(true);
  });

  it("does not force search for timeless general health education", () => {
    expect(shouldUsePublicWebSearch("高血压怎么预防？")).toBe(false);
  });
});
