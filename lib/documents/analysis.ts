import OpenAI from "openai";
import { z } from "zod";
import { getAiModelConfig, modelTemperature } from "@/lib/ai/config";

export const documentAnalysisSchema = z.object({
  documentType: z.enum([
    "lab_report",
    "exam_report",
    "prescription",
    "medicine_package",
    "discharge_summary",
    "other",
  ]),
  visibleText: z.array(z.string().trim().min(1).max(180)).max(30),
  plainSummary: z.array(z.string().trim().min(1).max(180)).max(8),
  questionsForClinician: z.array(z.string().trim().min(1).max(180)).max(6),
  uncertainItems: z.array(z.string().trim().min(1).max(180)).max(8),
  confidence: z.enum(["low", "medium", "high"]),
});

export type DocumentAnalysis = z.infer<typeof documentAnalysisSchema> & {
  safetyNotice: string;
  retained: false;
};

function boundedStrings(value: unknown, max: number) {
  const items =
    typeof value === "string"
      ? value.split(/\r?\n/)
      : Array.isArray(value)
        ? value
        : [];
  return items
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.slice(0, 180))
    .slice(0, max);
}

function normalizeDocumentType(value: unknown) {
  const text = String(value ?? "").toLowerCase();
  if (/化验|检验|lab/.test(text)) return "lab_report" as const;
  if (/检查|影像|exam|imaging/.test(text)) return "exam_report" as const;
  if (/处方|prescription/.test(text)) return "prescription" as const;
  if (/药盒|药品|medicine|package/.test(text)) return "medicine_package" as const;
  if (/出院|discharge/.test(text)) return "discharge_summary" as const;
  return "other" as const;
}

function normalizeConfidence(value: unknown) {
  if (["low", "medium", "high"].includes(String(value)))
    return value as "low" | "medium" | "high";
  const number = Number(value);
  if (Number.isFinite(number)) {
    if (number >= 0.85) return "high" as const;
    if (number >= 0.6) return "medium" as const;
  }
  return "low" as const;
}

const systemPrompt = `你是家医 Claw 的医疗文件整理模块。你的任务只限于忠实读取图片中清晰可见的文字，并帮助居民准备与医生沟通。

必须遵守：
1. 不诊断、不判断病情严重程度，不给治疗、处方、停药、换药或剂量建议。
2. 不补全看不清或图片中不存在的信息；不确定内容写入 uncertainItems。
3. 对检验数值只抄录图片中同时可见的项目、结果、单位和参考范围，不自行判断正常或异常。
4. plainSummary 使用通俗中文复述图片明确写出的内容，每条一句。
5. questionsForClinician 生成居民可以向家庭医生核实的问题，不给出问题答案。
6. 只输出 JSON，不要 Markdown。`;

function extractJson(value: string) {
  const trimmed = value.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  throw new Error("DOCUMENT_ANALYSIS_INVALID_JSON");
}

export function parseDocumentAnalysis(value: string): DocumentAnalysis {
  const raw = JSON.parse(extractJson(value)) as Record<string, unknown>;
  let visibleText = boundedStrings(
    raw.visibleText ?? raw.visible_text ?? raw.extractedText ?? raw.extracted_text,
    30,
  );
  if (!visibleText.length) {
    visibleText = Object.entries(raw)
      .filter(([, item]) => ["string", "number"].includes(typeof item))
      .map(([key, item]) => `${key}：${String(item)}`.slice(0, 180))
      .slice(0, 20);
  }
  const plainSummary = boundedStrings(
    raw.plainSummary ?? raw.plain_summary ?? raw.summary,
    8,
  );
  const questionsForClinician = boundedStrings(
    raw.questionsForClinician ?? raw.questions_for_clinician ?? raw.questions,
    6,
  );
  const parsed = documentAnalysisSchema.parse({
    documentType: normalizeDocumentType(raw.documentType ?? raw.document_type),
    visibleText,
    plainSummary: plainSummary.length
      ? plainSummary
      : visibleText.slice(0, 6).map((item) => `图片中可见：${item}`),
    questionsForClinician: questionsForClinician.length
      ? questionsForClinician
      : ["这份文件中的内容需要结合我的哪些情况进一步核对？"],
    uncertainItems: boundedStrings(
      raw.uncertainItems ?? raw.uncertain_items ?? raw.uncertain,
      8,
    ),
    confidence: normalizeConfidence(raw.confidence),
  });
  return {
    ...parsed,
    safetyNotice:
      "识别结果可能有误，请以原始文件和医生核对为准。Claw 不提供诊断、处方或用药调整建议。",
    retained: false,
  };
}

export async function analyzeMedicalDocumentImage(
  bytes: Buffer,
  mediaType: "image/jpeg" | "image/png" | "image/webp",
) {
  const config = getAiModelConfig("vision");
  const apiKey = config.apiKey;
  if (!apiKey) throw new Error("DOCUMENT_VISION_NOT_CONFIGURED");

  const client = new OpenAI({
    apiKey,
    baseURL: config.baseURL,
  });
  const model = config.model;
  const dataUrl = `data:${mediaType};base64,${bytes.toString("base64")}`;
  const completion = await client.chat.completions.create(
    {
      model,
      temperature: modelTemperature(model, true),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: dataUrl } },
            {
              type: "text",
              text: "请整理这张医疗文件图片，并按 documentType、visibleText、plainSummary、questionsForClinician、uncertainItems、confidence 输出 JSON。",
            },
          ],
        },
      ],
      ...(config.provider === "aliyun_bailian" ? { enable_thinking: false } : {}),
    },
    { signal: AbortSignal.timeout(45_000) },
  );
  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("DOCUMENT_ANALYSIS_EMPTY");
  return {
    analysis: parseDocumentAnalysis(content),
    model,
  };
}

export function detectImageMediaType(bytes: Buffer) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg" as const;
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png" as const;
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp" as const;
  return null;
}
