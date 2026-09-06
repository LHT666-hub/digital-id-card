import { beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import evalCases from "@/data/rag-eval-cases.json";
import { publicInfoItems } from "@/data/publicInfo";
import { getEmbeddingProvider } from "@/lib/rag/embeddings";
import { searchKnowledge } from "@/lib/rag/search";

const live = process.env.RAG_LIVE_EVAL === "true" ? describe : describe.skip;
const smokeCaseIds = new Set([
  "haiwan-vaccine-saturday-2",
  "wusi-vaccine-location",
  "nanqiao-vaccine-days",
  "nanqiao-tcm-friday",
  "haiwan-contact-phone",
  "sh-family-doctor-111",
  "family-doctor-package",
  "national-hypertension-standard",
]);

live("live Supabase hybrid RAG", () => {
  let supabase: SupabaseClient;
  let organizationId = "";

  beforeAll(async () => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("RAG_LIVE_EVAL_REQUIRES_SUPABASE_SERVICE_ROLE");
    const provider = getEmbeddingProvider();
    if (!provider || provider.id !== "openai-compatible") {
      throw new Error("RAG_LIVE_EVAL_REQUIRES_REAL_EMBEDDING_PROVIDER");
    }
    supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await supabase.from("organizations")
      .select("id")
      .eq("slug", process.env.RAG_EVAL_ORG_SLUG || "fengxian-primary-care")
      .single();
    if (error || !data) throw error ?? new Error("RAG_EVAL_ORGANIZATION_NOT_FOUND");
    organizationId = data.id;
  });

  it("has semantic vectors for the active knowledge corpus", async () => {
    const { count: total, error: totalError } = await supabase.from("knowledge_chunks")
      .select("id", { count: "exact", head: true });
    const { count: missing, error: missingError } = await supabase.from("knowledge_chunks")
      .select("id", { count: "exact", head: true })
      .is("embedding", null);
    if (totalError) throw totalError;
    if (missingError) throw missingError;
    expect(total ?? 0).toBeGreaterThan(0);
    expect(missing ?? 0, `${missing ?? 0}/${total ?? 0} knowledge chunks are missing embeddings`).toBe(0);
  });

  it("keeps representative resident queries above live quality gates", async () => {
    const cases = evalCases.filter((item) => smokeCaseIds.has(item.id));
    let hitAt1 = 0;
    let recallAt5 = 0;
    const failures: Array<{ id: string; query: string; expected: string[]; top: string[] }> = [];

    for (const testCase of cases) {
      const expectedTitles = publicInfoItems
        .filter((item) => testCase.expectedIds.includes(item.id))
        .map((item) => item.title);
      const hits = await searchKnowledge({
        supabase,
        query: testCase.query,
        organizationId,
        visibility: ["public", "resident"],
        limit: 8,
        force: true,
      });
      const topTitles = hits.slice(0, 5).map((item) => item.title);
      const rank = topTitles.findIndex((title) => expectedTitles.includes(title));
      if (rank === 0) hitAt1 += 1;
      if (rank >= 0) recallAt5 += 1;
      if (rank < 0) failures.push({ id: testCase.id, query: testCase.query, expected: expectedTitles, top: topTitles });
    }

    expect(failures, JSON.stringify(failures, null, 2)).toHaveLength(0);
    expect(recallAt5 / cases.length).toBe(1);
    expect(hitAt1 / cases.length).toBeGreaterThanOrEqual(0.75);
  }, 90_000);
});
