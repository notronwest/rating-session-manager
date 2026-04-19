import { createClient, SupabaseClient } from "@supabase/supabase-js";

let cachedClient: SupabaseClient | null = null;
let cachedOrgId: string | null = null;

export function getSupabase(): SupabaseClient {
  if (cachedClient) return cachedClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY) must be set");
  }
  cachedClient = createClient(url, key, { auth: { persistSession: false } });
  return cachedClient;
}

export async function getOrgId(): Promise<string> {
  if (cachedOrgId) return cachedOrgId;
  const slug = process.env.ORG_SLUG;
  if (!slug) throw new Error("ORG_SLUG must be set");
  const { data, error } = await getSupabase()
    .from("organizations")
    .select("id")
    .eq("slug", slug)
    .single();
  if (error || !data) throw new Error(`Could not resolve org "${slug}": ${error?.message}`);
  cachedOrgId = data.id;
  return data.id;
}
