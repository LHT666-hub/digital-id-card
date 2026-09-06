import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePaths = [
  path.join(root, "data", "official-public-info.json"),
  path.join(root, "data", "official-medical-guidelines.json"),
];
const dryRun = process.argv.includes("--dry-run");

function required(name, ...fallbacks) {
  const value = [process.env[name], ...fallbacks.map((key) => process.env[key])]
    .find((candidate) => candidate?.trim())
    ?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function stableUuid(key) {
  const bytes = Buffer.from(createHash("sha256").update(`jiayi-claw:${key}`).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function asTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid timestamp: ${value}`);
  return date.toISOString();
}

function buildContent(item) {
  return [
    item.summary,
    item.details,
    `居民下一步：${item.nextStep}`,
    `来源发布日期：${item.sourcePublishedAt}`,
    `知识核验日期：${item.verifiedAt}`,
  ].filter(Boolean).join("\n\n");
}

async function processRagQueue() {
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "").replace(/\/$/, "");
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!appUrl || !cronSecret) {
    console.log("RAG queue left pending (NEXT_PUBLIC_APP_URL/CRON_SECRET not both configured). Published rows are still searchable by public-info lookup.");
    return;
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await fetch(`${appUrl}/api/v1/internal/rag/process`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cronSecret}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`RAG processing failed (${response.status}): ${body.slice(0, 300)}`);
    }
    const payload = await response.json();
    const claimed = Number(payload?.data?.claimed ?? 0);
    console.log(`RAG batch ${attempt + 1}: claimed ${claimed}`);
    if (claimed === 0) break;
  }
}

const packs = await Promise.all(sourcePaths.map(async (sourcePath) => {
  const parsed = JSON.parse(await readFile(sourcePath, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`Official knowledge pack is not an array: ${sourcePath}`);
  return parsed;
}));
const items = packs.flat();
if (items.length === 0) throw new Error("Official knowledge packs are empty.");

const ids = new Set();
for (const item of items) {
  if (!item?.id || !item?.title || !item?.sourceUrl || !item?.verifiedAt) {
    throw new Error(`Invalid official knowledge item: ${JSON.stringify(item).slice(0, 200)}`);
  }
  if (ids.has(item.id)) throw new Error(`Duplicate official knowledge id: ${item.id}`);
  ids.add(item.id);
}

const rows = items.map((item) => ({
  id: stableUuid(item.id),
  title: item.title,
  category: item.category,
  content: buildContent(item),
  keywords: item.keywords,
  source_name: item.sourceName,
  source_url: item.sourceUrl,
  effective_from: item.sourcePublishedAt || null,
  expires_at: asTimestamp(item.expiresAt),
  verified_at: asTimestamp(`${item.verifiedAt}T00:00:00+08:00`),
  status: "published",
  updated_at: new Date().toISOString(),
}));

if (dryRun) {
  console.log(JSON.stringify({ count: rows.length, rows }, null, 2));
  process.exit(0);
}

const supabaseUrl = required("NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL");
const serviceRoleKey = required("SUPABASE_SERVICE_ROLE_KEY");
const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { data: organization, error: organizationError } = await supabase
  .from("organizations")
  .select("id")
  .eq("slug", "fengxian-primary-care")
  .single();
if (organizationError || !organization) {
  throw organizationError ?? new Error("Organization fengxian-primary-care not found.");
}

const scopedRows = rows.map((row) => ({
  ...row,
  organization_id: organization.id,
  community_id: null,
  verified_by: null,
}));

const { data, error } = await supabase
  .from("public_info_entries")
  .upsert(scopedRows, { onConflict: "id" })
  .select("id,title,status,verified_at,expires_at");
if (error) throw error;

console.log(`Synced ${data?.length ?? 0}/${scopedRows.length} official knowledge entries to Supabase.`);
await processRagQueue();
