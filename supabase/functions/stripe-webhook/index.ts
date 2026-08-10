import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "stripe-signature, content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
  });
}

function requiredEnv(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function parseStripeSignature(header: string) {
  const parts = header.split(",").map((part) => part.trim().split("="));
  const timestamp = parts.find(([key]) => key === "t")?.[1] ?? "";
  const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value);
  return { timestamp, signatures };
}

function timingSafeEqualHex(left: string, right: string) {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

async function hmacSha256Hex(message: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function verifyStripeSignature(body: string, signatureHeader: string) {
  const webhookSecret = requiredEnv("STRIPE_WEBHOOK_SECRET");
  const { timestamp, signatures } = parseStripeSignature(signatureHeader);
  if (!timestamp || signatures.length === 0) return false;

  const signedPayload = `${timestamp}.${body}`;
  const expected = await hmacSha256Hex(signedPayload, webhookSecret);
  return signatures.some((signature) => timingSafeEqualHex(signature, expected));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: jsonResponse({}).headers });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const rawBody = await req.text();
    const signature = req.headers.get("stripe-signature") ?? "";
    if (!(await verifyStripeSignature(rawBody, signature))) {
      return jsonResponse({ error: "Invalid Stripe signature" }, 400);
    }

    const event = JSON.parse(rawBody);
    const supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false },
    });

    const { data: existingEvent, error: duplicateReadError } = await supabase
      .from("stripe_webhook_events")
      .select("event_id")
      .eq("event_id", event.id)
      .maybeSingle();
    if (duplicateReadError) throw duplicateReadError;
    if (existingEvent) return jsonResponse({ received: true, duplicate: true });

    if (event.type !== "checkout.session.completed") {
      const { error: ignoredInsertError } = await supabase.from("stripe_webhook_events").insert({
        event_id: event.id,
        event_type: event.type,
        livemode: Boolean(event.livemode),
      });
      if (ignoredInsertError?.code !== "23505" && ignoredInsertError) throw ignoredInsertError;
      return jsonResponse({ received: true, ignored: true });
    }

    const session = event.data?.object ?? {};
    const userId = session.metadata?.supabase_user_id ?? session.client_reference_id;
    const paid = session.payment_status === "paid" || session.status === "complete";
    if (!userId || !paid) {
      const { error: ignoredInsertError } = await supabase.from("stripe_webhook_events").insert({
        event_id: event.id,
        event_type: event.type,
        livemode: Boolean(event.livemode),
      });
      if (ignoredInsertError?.code !== "23505" && ignoredInsertError) throw ignoredInsertError;
      return jsonResponse({ received: true, ignored: true });
    }

    if (session.customer) {
      const { error: customerError } = await supabase.from("billing_customers").upsert({
        user_id: userId,
        stripe_customer_id: session.customer,
        email: session.customer_details?.email ?? null,
      });
      if (customerError) throw customerError;
    }

    const { error: entitlementError } = await supabase.from("billing_entitlements").upsert({
      user_id: userId,
      tier: "pro_lifetime",
      active: true,
      source: "stripe_checkout",
      stripe_checkout_session_id: session.id,
      stripe_customer_id: session.customer ?? null,
      granted_at: new Date().toISOString(),
    });
    if (entitlementError) throw entitlementError;

    const { error: eventInsertError } = await supabase.from("stripe_webhook_events").insert({
      event_id: event.id,
      event_type: event.type,
      livemode: Boolean(event.livemode),
    });
    if (eventInsertError?.code !== "23505" && eventInsertError) throw eventInsertError;

    return jsonResponse({ received: true });
  } catch (error) {
    console.error("stripe-webhook failed", error);
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
