import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { signLicense } from "../_shared/meeting-license.mjs";

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers });
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers });
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);
  try {
    const token = (req.headers.get("Authorization") ?? "").replace(
      /^Bearer\s+/i,
      "",
    );
    if (!token) return reply({ error: "Sign in to verify Echo Pro" }, 401);
    const client = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );
    const {
      data: { user },
      error: authError,
    } = await client.auth.getUser(token);
    if (authError || !user) return reply({ error: "Session expired" }, 401);
    const { data, error } = await client
      .from("billing_entitlements")
      .select("tier,active")
      .eq("user_id", user.id)
      .maybeSingle();
    if (error)
      return reply(
        { error: "Purchase verification is temporarily unavailable" },
        503,
      );
    // An explicit inactive response is authoritative; network/auth errors are not revocations.
    if (!data?.active || data.tier !== "pro_lifetime")
      return reply({ active: false, userId: user.id });
    const secret = Deno.env.get("MEETINGS_LICENSE_PRIVATE_KEY"),
      keyId = Deno.env.get("MEETINGS_LICENSE_KEY_ID");
    if (!secret || !keyId)
      return reply(
        { error: "Offline Meetings licences are not configured" },
        503,
      );
    return reply({
      active: true,
      userId: user.id,
      license: await signLicense(user.id, keyId, secret),
    });
  } catch {
    return reply(
      { error: "Purchase verification is temporarily unavailable" },
      503,
    );
  }
});
