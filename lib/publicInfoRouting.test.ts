import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { searchKnowledge as searchDemoKnowledge } from "@/lib/knowledge";
import { searchPublicInfo } from "@/lib/publicInfoRepository";

const previousDemoMode = process.env.NEXT_PUBLIC_DEMO_MODE;

beforeAll(() => {
  process.env.NEXT_PUBLIC_DEMO_MODE = "true";
});

afterAll(() => {
  if (previousDemoMode === undefined) delete process.env.NEXT_PUBLIC_DEMO_MODE;
  else process.env.NEXT_PUBLIC_DEMO_MODE = previousDemoMode;
});

describe("assistant public-info routing", () => {
  it("does not hijack general health questions", async () => {
    expect(await searchPublicInfo("高血压怎么预防？")).toEqual([]);
    expect(await searchPublicInfo("糖尿病患者平时饮食注意什么？")).toEqual([]);
    expect(searchDemoKnowledge("高血压怎么预防？")).toEqual([]);
  });

  it("leaves fresh generic public policy questions to the web-capable model", async () => {
    expect(await searchPublicInfo("帮我查一下最新医保政策")).toEqual([]);
    expect(await searchPublicInfo("最新上海医保政策有什么变化？")).toEqual([]);
  });

  it("still lets reviewed management questions use demo knowledge", () => {
    expect(searchDemoKnowledge("高血压随访要注意什么？").length).toBeGreaterThan(0);
  });
});
