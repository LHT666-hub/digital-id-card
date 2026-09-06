import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registryPath = path.join(root, "data", "knowledge-source-registry.json");

function required(name, ...fallbacks) {
  const value = [process.env[name], ...fallbacks.map((key) => process.env[key])]
    .find((candidate) => candidate?.trim())
    ?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function normalize(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, "").trim();
}

function stableUuid(key) {
  const bytes = Buffer.from(createHash("sha256").update(`jiayi-medical-entity:${key}`).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const inputPath = arg("--input");
const sourceRegistryId = arg("--source");
const batchSize = Math.min(Math.max(Number(arg("--batch") ?? 500), 10), 1000);
const dryRun = process.argv.includes("--dry-run");
if (!inputPath || !sourceRegistryId) {
  throw new Error("Usage: node scripts/import-medical-entity-ontology.mjs --input <file.ndjson> --source <registry-id> [--dry-run]");
}

const registry = JSON.parse(await readFile(registryPath, "utf8"));
const source = registry.find((item) => item.id === sourceRegistryId);
if (!source) throw new Error(`Knowledge source is not registered: ${sourceRegistryId}`);
if (!new Set(["approved_supporting", "approved_grounding"]).has(source.status)) {
  throw new Error(`Knowledge source is not approved for ontology import: ${sourceRegistryId} (${source.status})`);
}
if (!(source.allowedUses ?? []).some((use) => ["entity_linking", "drug_alias_normalization", "disease_alias_normalization"].includes(use))) {
  throw new Error(`Knowledge source is not approved for entity normalization: ${sourceRegistryId}`);
}

let supabase = null;
if (!dryRun) {
  supabase = createClient(
    required("NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL"),
    required("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

async function flush(records) {
  if (!records.length) return;
  const entities = records.map((record) => {
    const entityType = String(record.entityType ?? "other").toLowerCase();
    const standardName = String(record.standardName ?? "").trim();
    const sourceKey = String(record.sourceKey ?? "").trim();
    if (!standardName || !sourceKey) throw new Error("Each record needs sourceKey and standardName");
    return {
      id: stableUuid(`${sourceRegistryId}:${sourceKey}`),
      entity_type: ["drug", "disease", "gene", "symptom", "test", "procedure", "other"].includes(entityType) ? entityType : "other",
      standard_name: standardName,
      normalized_name: normalize(standardName),
      source_registry_id: sourceRegistryId,
      source_key: sourceKey,
      authority_tier: source.authorityTier ?? "B",
      metadata: record.metadata ?? {},
      reviewed_at: source.reviewRequired ? null : new Date().toISOString(),
    };
  });

  if (dryRun) return;
  const { error: entityError } = await supabase.from("medical_entities")
    .upsert(entities, { onConflict: "source_registry_id,source_key" });
  if (entityError) throw entityError;

  const aliases = [];
  records.forEach((record, index) => {
    const entityId = entities[index].id;
    const standardName = entities[index].standard_name;
    const rawAliases = Array.isArray(record.aliases) ? record.aliases : [];
    const values = new Set([standardName]);
    for (const alias of rawAliases) {
      if (typeof alias === "string" && alias.trim()) values.add(alias.trim());
      else if (alias && typeof alias.value === "string" && alias.value.trim()) values.add(alias.value.trim());
    }
    for (const value of values) {
      aliases.push({
        entity_id: entityId,
        alias: value,
        normalized_alias: normalize(value),
        alias_type: value === standardName ? "synonym" : "synonym",
        source_registry_id: sourceRegistryId,
      });
    }
  });

  for (let start = 0; start < aliases.length; start += 1000) {
    const { error: aliasError } = await supabase.from("medical_entity_aliases")
      .upsert(aliases.slice(start, start + 1000), { onConflict: "entity_id,normalized_alias" });
    if (aliasError) throw aliasError;
  }
}

const reader = createInterface({
  input: createReadStream(inputPath, { encoding: "utf8" }),
  crlfDelay: Infinity,
});

let batch = [];
let count = 0;
for await (const line of reader) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  batch.push(JSON.parse(trimmed));
  if (batch.length >= batchSize) {
    await flush(batch);
    count += batch.length;
    batch = [];
    console.log(`${dryRun ? "Validated" : "Imported"} ${count} entities...`);
  }
}
if (batch.length) {
  await flush(batch);
  count += batch.length;
}

console.log(`${dryRun ? "Validated" : "Imported"} ${count} entities from ${sourceRegistryId}.`);
