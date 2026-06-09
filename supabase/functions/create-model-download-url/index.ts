import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const DOWNLOAD_BASE_URL = "https://pettals.co.uk/echo/technology/download-model.php";
const SIGNING_SECRET = Deno.env.get("MODEL_DOWNLOAD_SIGNING_SECRET");
const MODEL_TTL_SECONDS = 5 * 60;
const ALLOWED_MODELS = new Set(["small", "medium"]);

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    },
  });
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
    });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  if (!SIGNING_SECRET) {
    return jsonResponse({ error: "Model download signer is not configured" }, 500);
  }

  const payload = await req.json().catch(() => ({}));
  const modelSize = typeof payload.modelSize === "string" ? payload.modelSize : "";

  if (!ALLOWED_MODELS.has(modelSize)) {
    return jsonResponse({ error: "Unknown model size" }, 400);
  }

  const expires = Math.floor(Date.now() / 1000) + MODEL_TTL_SECONDS;
  const signature = await hmacSha256Hex(`${modelSize}:${expires}`, SIGNING_SECRET);
  const url = new URL(DOWNLOAD_BASE_URL);
  url.searchParams.set("model", modelSize);
  url.searchParams.set("expires", String(expires));
  url.searchParams.set("signature", signature);

  return jsonResponse({ url: url.toString(), expires });
});
