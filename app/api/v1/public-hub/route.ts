import type { NextRequest } from "next/server";
import { apiOk, createTraceId } from "@/lib/api/response";
import { getPublishedContent } from "@/lib/db/carePlatform";
import { searchPublicInfo } from "@/lib/publicInfoRepository";
import { getSupabaseAnonKey, getSupabaseUrl, isSupabaseConfigured } from "@/lib/supabase/env";
import { createSupabasePublicServerClient } from "@/lib/supabase/server";

async function isPublicDataServiceReachable() {
  if (!isSupabaseConfigured()) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_500);
  try {
    await fetch(`${getSupabaseUrl()}/rest/v1/`, {
      headers: { apikey: getSupabaseAnonKey() },
      cache: "no-store",
      signal: controller.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function GET(request: NextRequest) {
  const traceId = createTraceId();
  const query = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  const serviceReachable = await isPublicDataServiceReachable();
  const publicInfo = serviceReachable ? await searchPublicInfo(query, { force: true }) : [];
  const supabase = serviceReachable ? createSupabasePublicServerClient() : null;
  let content: Awaited<ReturnType<typeof getPublishedContent>> = [];

  if (supabase) {
    try {
      content = await getPublishedContent({ supabase, limit: 12 });
    } catch {
      // Public guides remain available if the editorial feed is unavailable.
    }
  }

  return apiOk(
    {
      query,
      publicInfo,
      content,
      serviceConfigured: serviceReachable,
      publishedOnly: true,
    },
    traceId,
  );
}
