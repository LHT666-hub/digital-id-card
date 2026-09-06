import { describe, expect, it } from "vitest";
import {
  filterConfidentKnowledgeHits,
  shouldSearchInstitutionalKnowledge,
} from "@/lib/rag/search";
import type { KnowledgeSearchHit } from "@/lib/rag/types";

function hit(overrides: Partial<KnowledgeSearchHit>): KnowledgeSearchHit {
  return {
    index: 1,
    chunkId: "chunk",
    documentId: "doc",
    sourceId: "source",
    sourceType: "public_info",
    title: "测试资料",
    heading: null,
    sourceName: "测试来源",
    sourceUrl: "https://example.com",
    reviewedAt: "2026-09-06T00:00:00Z",
    version: 1,
    content: "测试内容",
    category: "测试",
    expiresAt: null,
    textScore: 0,
    vectorScore: 0,
    combinedScore: 0,
    ...overrides,
  };
}

describe("RAG routing", () => {
  it("keeps general health education on the base model", () => {
    expect(shouldSearchInstitutionalKnowledge("高血压是什么？")).toBe(false);
    expect(shouldSearchInstitutionalKnowledge("二甲双胍是干什么的？")).toBe(false);
    expect(shouldSearchInstitutionalKnowledge("每天走多少步比较合适？")).toBe(false);
  });

  it("keeps public time-sensitive policy questions off institutional RAG", () => {
    expect(shouldSearchInstitutionalKnowledge("帮我查一下最新医保政策")).toBe(false);
    expect(shouldSearchInstitutionalKnowledge("最新上海医保政策有什么变化？")).toBe(false);
  });

  it("routes local and current service questions to verified knowledge", () => {
    expect(shouldSearchInstitutionalKnowledge("今天家庭医生几点坐班？")).toBe(true);
    expect(shouldSearchInstitutionalKnowledge("社区卫生服务中心怎么签约？")).toBe(true);
    expect(shouldSearchInstitutionalKnowledge("体检报告在哪里查？")).toBe(true);
    expect(shouldSearchInstitutionalKnowledge("续方需要什么材料？")).toBe(true);
    expect(shouldSearchInstitutionalKnowledge("奉贤家庭医生签约政策是什么？")).toBe(true);
  });

  it("rejects weak retrieval noise instead of feeding it to generation", () => {
    expect(filterConfidentKnowledgeHits([
      hit({ title: "无关政策", textScore: 0.083, combinedScore: 0.016 }),
      hit({ title: "另一个无关政策", textScore: 0.077, combinedScore: 0.015 }),
    ])).toHaveLength(0);
  });

  it("keeps a strong exact or semantic retrieval result", () => {
    expect(filterConfidentKnowledgeHits([
      hit({ title: "南桥镇预防接种门诊时间", textScore: 1, combinedScore: 0.016 }),
      hit({ title: "相关接种资料", textScore: 0.2, combinedScore: 0.015 }),
    ]).map((item) => item.title)).toEqual([
      "南桥镇预防接种门诊时间",
      "相关接种资料",
    ]);
  });
});
