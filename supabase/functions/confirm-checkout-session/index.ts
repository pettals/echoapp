import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const STRIPE_API_VERSION = "2026-02-25.clover";
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

async function stripeGet(path: string) {
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${requiredEnv("STRIPE_SECRET_KEY")}`,
      "Stripe-Version": STRIPE_API_VERSION,
    },
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message ?? `Stripe request failed with ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

function entitlementBody() {
  const checkedAt = new Date();
  const leaseUntil = new Date(checkedAt.getTime() + PRO_LEASE_MINUTES * 60 * 1000);
  return {
    tier: "pro_lifetime",
    features: {
      unlimitedHistory: true,
      cloudProvider: true,
    },
    checkedAt: checkedAt.toISOString(),
    graceUntil: null,
    leaseUntil: leaseUntil.toISOString(),
    requiresOnline: true,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: jsonResponse({}).headers });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) return jsonResponse({ error: "Sign in before confirming checkout" }, 401);

    const body = await req.json().catch(() => ({}));
    const checkoutSessionId = typeof body.checkoutSessionId === "string" ? body.checkoutSessionId.trim() : "";
    if (!checkoutSessionId.startsWith("cs_")) return jsonResponse({ error: "Invalid checkout session" }, 400);

    const supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false },
    });
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData.user) return jsonResponse({ error: "Invalid session" }, 401);

    const session = await stripeGet(`/checkout/sessions/${encodeURIComponent(checkoutSessionId)}`);
    const userId = userData.user.id;
    const sessionUserId = session.metadata?.supabase_user_id ?? session.client_reference_id;
    if (sessionUserId !== userId) return jsonResponse({ error: "Checkout session does not belong to this account" }, 403);

    const paid = session.payment_status === "paid" || session.status === "complete";
    if (!paid) return jsonResponse({ error: "Checkout is not paid yet" }, 409);

    if (session.customer) {
      const { error: customerError } = await supabase.from("billing_customers").upsert({
        user_id: userId,
        stripe_customer_id: session.customer,
        email: session.customer_details?.email ?? userData.user.email ?? null,
      });
      if (customerError) throw customerError;
    }

    const { error: entitlementError } = await supabase.from("billing_entitlements").upsert({
      user_id: userId,
      tier: "pro_lifetime",
      active: true,
      source: "stripe_checkout_confirm",
      stripe_checkout_session_id: session.id,
      stripe_customer_id: session.customer ?? null,
      granted_at: new Date().toISOString(),
    });
    if (entitlementError) throw entitlementError;

    const { error: eventError } = await supabase.from("stripe_webhook_events").upsert({
      event_id: `checkout_session:${session.id}`,
      event_type: "checkout.session.confirmed",
      livemode: Boolean(session.livemode),
    });
    if (eventError) throw eventError;

    return jsonResponse(entitlementBody());
  } catch (error) {
    console.error("confirm-checkout-session failed", error);
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
