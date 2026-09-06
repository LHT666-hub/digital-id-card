import { apiError, apiOk, createTraceId } from "@/lib/api/response";
import {
  getSupabaseServiceRoleKey,
  getSupabaseUrl,
} from "@/lib/supabase/env";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type JwtPayload = {
  iss?: string;
  ref?: string;
  role?: string;
  exp?: number;
};

function getServiceRoleMetadata() {
  const key = getSupabaseServiceRoleKey();
  const url = getSupabaseUrl();
  let payload: JwtPayload | null = null;
  const parts = key.split(".");
  if (parts.length === 3) {
    try {
      payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as JwtPayload;
    } catch {
      payload = null;
    }
  }

  let expectedRef: string | null = null;
  try {
    expectedRef = new URL(url).hostname.split(".")[0] || null;
  } catch {
    expectedRef = null;
  }

  return {
    expectedRef,
    keyFormat: key.startsWith("sb_secret_")
      ? "secret"
      : parts.length === 3
        ? "jwt"
        : "unknown",
    keyLength: key.length,
    jwtRole: payload?.role ?? null,
    jwtRef: payload?.ref ?? null,
    jwtIssuer: payload?.iss ?? null,
    jwtExpiresAt: payload?.exp
      ? new Date(payload.exp * 1000).toISOString()
      : null,
  };
}

async function probeServiceRoleRest() {
  const key = getSupabaseServiceRoleKey();
  const url = getSupabaseUrl().replace(/\/$/, "");
  if (!key || !url) return { status: null, error: "not_configured" };

  try {
    const response = await fetch(`${url}/rest/v1/organizations?select=id&limit=1`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(4_000),
    });
    if (response.ok) return { status: response.status, error: null };

    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    return {
      status: response.status,
      error: {
        code: typeof body?.code === "string" ? body.code : null,
        message: typeof body?.message === "string" ? body.message : null,
        hint: typeof body?.hint === "string" ? body.hint : null,
        details: typeof body?.details === "string" ? body.details : null,
      },
    };
  } catch (error) {
    return {
      status: null,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
}

export async function GET() {
  const traceId = createTraceId();
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) {
    console.error("[health-ready] service role client is not configured", {
      traceId,
      serviceRole: getServiceRoleMetadata(),
    });
    return apiError("SERVICE_NOT_CONFIGURED", "服务端数据库尚未配置。", 503, traceId);
  }

  const startedAt = Date.now();
  const { error } = await supabase
    .from("organizations")
    .select("id", { head: true, count: "exact" })
    .limit(1);

  if (error) {
    const restProbe = await probeServiceRoleRest();
    console.error("[health-ready] database readiness check failed", {
      traceId,
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
      serviceRole: getServiceRoleMetadata(),
      restProbe,
    });
    return apiError("DATABASE_NOT_READY", "数据库暂不可用。", 503, traceId);
  }

  return apiOk(
    { status: "ready", database: "ok", latencyMs: Date.now() - startedAt },
    traceId,
  );
}
