import { describe, expect, it } from "vitest";
import { publicInfoItems } from "@/data/publicInfo";
import { rankPublicInfoRecords, type PublicInfoRecord } from "@/lib/publicInfoRepository";
import { shouldSearchInstitutionalKnowledge } from "@/lib/rag/search";

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

describe("P0 official medical knowledge", () => {
  it("keeps general education on the base model", () => {
    expect(shouldSearchInstitutionalKnowledge("高血压是什么")).toBe(false);
    expect(shouldSearchInstitutionalKnowledge("糖尿病是什么")).toBe(false);
    expect(shouldSearchInstitutionalKnowledge("慢阻肺是什么")).toBe(false);
  });

  it("routes disease management questions to reviewed knowledge", () => {
    expect(shouldSearchInstitutionalKnowledge("高血压控制好了多久随访一次")).toBe(true);
    expect(shouldSearchInstitutionalKnowledge("2型糖尿病社区一年随访几次")).toBe(true);
    expect(shouldSearchInstitutionalKnowledge("慢阻肺一年需要随访几次")).toBe(true);
  });

  it("retrieves hypertension followup guidance", () => {
    const ranked = rankPublicInfoRecords(records(), "高血压控制好了多久随访一次");
    expect(ranked.slice(0, 3).map((item) => item.id)).toContain("medical-hypertension-followup-referral-2025");
  });

  it("retrieves type 2 diabetes community followup guidance", () => {
    const ranked = rankPublicInfoRecords(records(), "2型糖尿病社区一年随访几次");
    expect(ranked.slice(0, 3).map((item) => item.id)).toContain("medical-t2dm-public-health-followup");
  });

  it("retrieves COPD followup guidance", () => {
    const ranked = rankPublicInfoRecords(records(), "慢阻肺一年需要随访几次");
    expect(ranked.slice(0, 3).map((item) => item.id)).toContain("medical-copd-public-health-followup-2024");
  });
});
