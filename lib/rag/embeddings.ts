import { createHash } from "node:crypto";
import OpenAI from "openai";
import { RAG_EMBEDDING_DIMENSIONS } from "@/lib/rag/types";
import { getEmbeddingModelConfig } from "@/lib/ai/config";

export type EmbeddingProvider = {
  id: string;
  model: string;
  dimensions: number;
  embedMany(inputs: string[]): Promise<number[][]>;
};

function normalize(vector: number[]) {
  const magnitude = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0));
  return magnitude ? vector.map((item) => item / magnitude) : vector;
}

function deterministicVector(input: string, dimensions: number) {
  const normalized = input.toLowerCase().replace(/\s+/g, "").trim();
  const tokens = new Set<string>();
  for (let index = 0; index < normalized.length; index += 1) {
    tokens.add(normalized.slice(index, index + 1));
    if (index + 1 < normalized.length) tokens.add(normalized.slice(index, index + 2));
  }
  const vector = Array<number>(dimensions).fill(0);
  for (const token of tokens) {
    const digest = createHash("sha256").update(token).digest();
    const slot = digest.readUInt32BE(0) % dimensions;
    vector[slot] += digest[4] % 2 === 0 ? 1 : -1;
  }
  return normalize(vector);
}

export function createDeterministicEmbeddingProvider(dimensions = RAG_EMBEDDING_DIMENSIONS): EmbeddingProvider {
  return {
    id: "deterministic",
    model: `deterministic-zh-ngram-${dimensions}`,
    dimensions,
    async embedMany(inputs) {
      return inputs.map((input) => deterministicVector(input, dimensions));
    },
  };
}

function createOpenAiCompatibleProvider(): EmbeddingProvider {
  const { apiKey, baseURL, model } = getEmbeddingModelConfig();
  const dimensions = Number(process.env.RAG_EMBEDDING_DIMENSIONS ?? RAG_EMBEDDING_DIMENSIONS);
  if (!apiKey || !baseURL || !model) throw new Error("RAG_EMBEDDING_CONFIG_INCOMPLETE");
  if (dimensions !== RAG_EMBEDDING_DIMENSIONS) throw new Error("RAG_EMBEDDING_DIMENSIONS_MUST_BE_1024");
  const client = new OpenAI({ apiKey, baseURL });
  return {
    id: "openai-compatible",
    model,
    dimensions,
    async embedMany(inputs) {
      const response = await client.embeddings.create({ model, input: inputs, dimensions });
      const vectors = [...response.data].sort((a, b) => a.index - b.index).map((item) => item.embedding);
      if (vectors.length !== inputs.length || vectors.some((item) => item.length !== dimensions)) {
        throw new Error("RAG_EMBEDDING_RESPONSE_INVALID");
      }
      return vectors;
    },
  };
}

function hasConfiguredEmbeddingModel() {
  try {
    const config = getEmbeddingModelConfig();
    return Boolean(config.apiKey && config.baseURL && config.model);
  } catch {
    return false;
  }
}

export function getEmbeddingProvider(): EmbeddingProvider | null {
  const selected = process.env.RAG_EMBEDDING_PROVIDER?.trim().toLowerCase();
  if (selected === "disabled") return null;
  if (selected === "openai-compatible") return createOpenAiCompatibleProvider();
  if (selected === "deterministic") {
    if (process.env.NODE_ENV === "production" && process.env.RAG_ALLOW_DETERMINISTIC !== "true") {
      throw new Error("RAG_DETERMINISTIC_PROVIDER_FORBIDDEN_IN_PRODUCTION");
    }
    return createDeterministicEmbeddingProvider();
  }

  if (process.env.NODE_ENV === "test") return createDeterministicEmbeddingProvider();

  // If the app already has a Bailian/OpenAI-compatible embedding configuration
  // (for Bailian this reuses DASHSCOPE_API_KEY + text-embedding-v4), enable
  // semantic retrieval by default. `RAG_EMBEDDING_PROVIDER=disabled` remains
  // the explicit kill switch.
  return hasConfiguredEmbeddingModel() ? createOpenAiCompatibleProvider() : null;
}

export function vectorToSql(vector: number[]) {
  if (vector.length !== RAG_EMBEDDING_DIMENSIONS) throw new Error("RAG_VECTOR_DIMENSIONS_INVALID");
  return `[${vector.map((item) => Number(item.toFixed(8))).join(",")}]`;
}
