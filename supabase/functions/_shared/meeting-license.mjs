function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
export async function signLicense(userId, keyId, pkcs8) {
  const bytes = Uint8Array.from(atob(pkcs8), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    bytes,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const payload = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      issuer: "echo",
      audience: "echo-meetings",
      userId,
      tier: "pro_lifetime",
      issuedAt: new Date().toISOString(),
      features: ["meetings"],
    }),
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("Ed25519", key, payload),
  );
  return {
    keyId,
    payload: base64url(payload),
    signature: base64url(signature),
  };
}
