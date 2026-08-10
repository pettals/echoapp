import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const STRIPE_API_VERSION = "2026-02-25.clover";
const DEFAULT_SUCCESS_URL = "echo://billing/complete?session_id={CHECKOUT_SESSION_ID}";
const DEFAULT_CANCEL_URL = "echo://billing/cancel";

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

function checkoutReturnUrl(value: unknown, fallback: string) {
  if (typeof value !== "string") return fallback;
  if (value.startsWith("https://") || value.startsWith("echo://billing/")) return value;
  return fallback;
}

async function stripePost(path: string, params: URLSearchParams) {
  const secretKey = requiredEnv("STRIPE_SECRET_KEY");
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": STRIPE_API_VERSION,
    },
    body: params,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message ?? `Stripe request failed with ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

function isMissingStripeCustomerError(error: unknown) {
  return error instanceof Error && /No such customer/i.test(error.message);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: jsonResponse({}).headers });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) return jsonResponse({ error: "Sign in before checkout" }, 401);

    const supabaseUrl = requiredEnv("SUPABASE_URL");
    const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    const priceId = requiredEnv("STRIPE_ECHO_PRO_PRICE_ID");
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData.user) return jsonResponse({ error: "Invalid session" }, 401);

    const user = userData.user;
    const { data: existingCustomer, error: customerReadError } = await supabase
      .from("billing_customers")
      .select("stripe_customer_id")
      .eq("user_id", user.id)
      .maybeSingle();
    if (customerReadError) throw customerReadError;

    async function createAndStoreCustomer() {
      const customerParams = new URLSearchParams();
      if (user.email) customerParams.set("email", user.email);
      customerParams.set("metadata[supabase_user_id]", user.id);
      const customer = await stripePost("/customers", customerParams);

      const { error: upsertError } = await supabase.from("billing_customers").upsert({
        user_id: user.id,
        stripe_customer_id: customer.id,
        email: user.email ?? null,
      });
      if (upsertError) throw upsertError;
      return customer.id as string;
    }

    let stripeCustomerId = existingCustomer?.stripe_customer_id as string | undefined;
    if (!stripeCustomerId) stripeCustomerId = await createAndStoreCustomer();

    const body = await req.json().catch(() => ({}));
    const successUrl = checkoutReturnUrl(
      body.successUrl,
      Deno.env.get("ECHO_CHECKOUT_SUCCESS_URL") ?? DEFAULT_SUCCESS_URL
    );
    const cancelUrl = checkoutReturnUrl(
      body.cancelUrl,
      Deno.env.get("ECHO_CHECKOUT_CANCEL_URL") ?? DEFAULT_CANCEL_URL
    );

    function checkoutSessionParams(customerId: string) {
      const sessionParams = new URLSearchParams();
      sessionParams.set("mode", "payment");
      sessionParams.set("customer", customerId);
      sessionParams.set("client_reference_id", user.id);
      sessionParams.set("success_url", successUrl);
      sessionParams.set("cancel_url", cancelUrl);
      sessionParams.set("line_items[0][price]", priceId);
      sessionParams.set("line_items[0][quantity]", "1");
      sessionParams.set("allow_promotion_codes", "true");
      sessionParams.set("metadata[supabase_user_id]", user.id);
      sessionParams.set("metadata[echo_tier]", "pro_lifetime");
      sessionParams.set("payment_intent_data[metadata][supabase_user_id]", user.id);
      sessionParams.set("payment_intent_data[metadata][echo_tier]", "pro_lifetime");
      return sessionParams;
    }

    let session;
    try {
      session = await stripePost("/checkout/sessions", checkoutSessionParams(stripeCustomerId));
    } catch (error) {
      if (!isMissingStripeCustomerError(error)) throw error;
      stripeCustomerId = await createAndStoreCustomer();
      session = await stripePost("/checkout/sessions", checkoutSessionParams(stripeCustomerId));
    }
    return jsonResponse({ url: session.url, id: session.id });
  } catch (error) {
    console.error("create-checkout-session failed", error);
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
