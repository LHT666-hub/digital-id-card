import type { RagSupabaseClient } from "@/lib/rag/types";

export type MedicalEntityMatch = {
  entity_id: string;
  entity_type: string;
  standard_name: string;
  matched_alias: string;
  match_score: number;
  source_registry_id: string;
  metadata: Record<string, unknown> | null;
};

export async function resolveMedicalEntityTerms(
  supabase: RagSupabaseClient,
  query: string,
  limit = 5,
): Promise<{ terms: string[]; matches: MedicalEntityMatch[] }> {
  const normalized = query.trim();
  if (!normalized) return { terms: [], matches: [] };

  try {
    const { data, error } = await supabase.rpc("resolve_medical_entities", {
      p_query: normalized,
      p_limit: Math.min(Math.max(limit, 1), 8),
    });
    if (error) {
      if (/resolve_medical_entities|medical_entities|schema cache/i.test(error.message)) {
        return { terms: [], matches: [] };
      }
      return { terms: [], matches: [] };
    }

    const matches = ((data ?? []) as MedicalEntityMatch[])
      .filter((item) => Number(item.match_score ?? 0) >= 0.72)
      .slice(0, limit);
    const terms = [...new Set(matches.flatMap((item) => [item.standard_name, item.matched_alias]).filter(Boolean))];
    return { terms, matches };
  } catch {
    return { terms: [], matches: [] };
  }
}
