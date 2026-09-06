import { describe, expect, it } from "vitest";
import { searchPublicInfo } from "@/lib/publicInfoRepository";

describe("assistant public-info routing", () => {
  it("does not hijack general health questions", async () => {
    expect(await searchPublicInfo("高血压怎么预防？")).toEqual([]);
    expect(await searchPublicInfo("糖尿病患者平时饮食注意什么？")).toEqual([]);
  });

  it("leaves fresh generic public policy questions to the web-capable model", async () => {
    expect(await searchPublicInfo("帮我查一下最新医保政策")).toEqual([]);
    expect(await searchPublicInfo("最新上海医保政策有什么变化？")).toEqual([]);
  });
});
