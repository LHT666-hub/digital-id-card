import officialInfo from "./official-public-info.json";
import officialMedicalGuidelines from "./official-medical-guidelines.json";
import type { PublicInfoItem } from "@/lib/types";

export type CuratedPublicInfoItem = PublicInfoItem & {
  scope: string;
  sourcePublishedAt: string;
  expiresAt?: string | null;
};

function residentFacing(value: string) {
  return value
    .split(/(?<=[。！？])/)
    .filter((sentence) => !/(?:Claw可用|后续知识库|知识库应|分块索引)/i.test(sentence))
    .join("")
    .trim();
}

/**
 * Curated public-service and official medical knowledge used as the safe local
 * fallback and as the canonical seed source for Supabase/RAG. `updatedAt`
 * means "last verified", not the original publication date; the latter is
 * preserved separately.
 */
const curatedKnowledge = [...officialInfo, ...officialMedicalGuidelines];

export const publicInfoItems: CuratedPublicInfoItem[] = curatedKnowledge.map((item) => ({
  id: item.id,
  title: item.title,
  category: item.category,
  keywords: item.keywords,
  summary: residentFacing(item.summary),
  details: residentFacing(item.details),
  nextStep: residentFacing(item.nextStep),
  sourceName: item.sourceName,
  sourceUrl: item.sourceUrl,
  updatedAt: item.verifiedAt,
  suggestDoctor: item.suggestDoctor,
  scope: item.scope,
  sourcePublishedAt: item.sourcePublishedAt,
  expiresAt: item.expiresAt,
}));
