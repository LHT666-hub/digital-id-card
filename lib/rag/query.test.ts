import { describe, expect, it } from "vitest";
import { expandRetrievalQuery, getRetrievalTerms, normalizeRetrievalQuery } from "@/lib/rag/query";

describe("RAG query normalization", () => {
  it("normalizes resident weekday phrasing", () => {
    expect(normalizeRetrievalQuery("海湾礼拜六能打疫苗吗？")).toContain("周六");
  });

  it("expands vaccination language and local aliases", () => {
    const query = expandRetrievalQuery("我住五四，礼拜六打预防针去哪？");
    expect(query).toContain("预防接种");
    expect(query).toContain("接种门诊");
    expect(query).toContain("五四分中心");
    expect(query).toContain("海湾镇");
    expect(query).toContain("周六");
  });

  it("expands family-doctor and long-prescription language", () => {
    const terms = getRetrievalTerms("家医能不能给我开长处方");
    expect(terms).toContain("家庭医生");
    expect(terms).toContain("家庭医生签约");
    expect(terms).toContain("长期处方");
  });

  it("expands local service-network wording", () => {
    const terms = getRetrievalTerms("海湾有几个分中心和服务点");
    expect(terms).toContain("海湾镇");
    expect(terms).toContain("分中心");
    expect(terms).toContain("服务点");
    expect(terms).toContain("服务网络");
  });
});
