import { describe, expect, it } from "vitest";
import evalCases from "@/data/rag-eval-cases.json";
import { publicInfoItems } from "@/data/publicInfo";
import { rankPublicInfoRecords, type PublicInfoRecord } from "@/lib/publicInfoRepository";

function records(): PublicInfoRecord[] {
  return publicInfoItems.map((item) => ({
    id: item.id,
    title: item.title,
    category: item.category,
    content: `${item.summary}\n\n${item.details}\n\n${item.nextStep}`,
    keywords: item.keywords,
    sourceName: item.sourceName,
    sourceUrl: item.sourceUrl,
    verifiedAt: item.updatedAt,
    expiresAt: item.expiresAt ?? null,
    status: "published",
    stale: false,
  }));
}

describe("golden public knowledge retrieval set", () => {
  it("keeps resident-language retrieval above minimum quality gates", () => {
    const corpus = records();
    let hitAt1 = 0;
    let recallAt5 = 0;
    let reciprocalRank = 0;

    const recallFailures: Array<{ id: string; query: string; topIds: string[] }> = [];
    const top1Misses: Array<{ id: string; query: string; expectedIds: string[]; topIds: string[] }> = [];

    for (const testCase of evalCases) {
      const ranked = rankPublicInfoRecords(corpus, testCase.query);
      const topIds = ranked.slice(0, 5).map((item) => item.id);
      const expected = new Set(testCase.expectedIds);
      const rank = ranked.findIndex((item) => expected.has(item.id));

      if (rank === 0) hitAt1 += 1;
      else top1Misses.push({ id: testCase.id, query: testCase.query, expectedIds: testCase.expectedIds, topIds });
      if (rank >= 0 && rank < 5) recallAt5 += 1;
      if (rank >= 0) reciprocalRank += 1 / (rank + 1);
      if (rank < 0 || rank >= 5) recallFailures.push({ id: testCase.id, query: testCase.query, topIds });
    }

    const total = evalCases.length;
    const metrics = {
      hitAt1: hitAt1 / total,
      recallAt5: recallAt5 / total,
      mrr: reciprocalRank / total,
    };

    expect(recallFailures, `Recall@5 failures: ${JSON.stringify(recallFailures, null, 2)}`).toHaveLength(0);
    expect(metrics.recallAt5).toBeGreaterThanOrEqual(0.95);
    expect(
      metrics.hitAt1,
      `Hit@1 misses (${top1Misses.length}/${total}): ${JSON.stringify(top1Misses, null, 2)}`,
    ).toBeGreaterThanOrEqual(0.8);
    expect(metrics.mrr).toBeGreaterThanOrEqual(0.85);
  });
});
