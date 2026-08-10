import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const PRO_LEASE_MINUTES = 5;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
  });
}

function requiredEnv(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function entitlementBody(tier: "free" | "pro_lifetime") {
  const checkedAt = new Date();
  const leaseUntil = new Date(checkedAt.getTime() + PRO_LEASE_MINUTES * 60 * 1000);
  const paid = tier === "pro_lifetime";
  return {
    tier,
    features: {
      unlimitedHistory: paid,
      cloudProvider: paid,
    },
    checkedAt: checkedAt.toISOString(),
    graceUntil: null,
    leaseUntil: paid ? leaseUntil.toISOString() : null,
    requiresOnline: true,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: jsonResponse({}).headers });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) return jsonResponse({ error: "Sign in before checking entitlement" }, 401);

    const supabaseUrl = requiredEnv("SUPABASE_URL");
    const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData.user) return jsonResponse({ error: "Invalid session" }, 401);

    const { data, error } = await supabase
      .from("billing_entitlements")
      .select("tier, active")
      .eq("user_id", userData.user.id)
      .maybeSingle();
    if (error) throw error;

    const tier = data?.active && data.tier === "pro_lifetime" ? "pro_lifetime" : "free";
    return jsonResponse(entitlementBody(tier));
  } catch (error) {
    console.error("get-entitlement failed", error);
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
