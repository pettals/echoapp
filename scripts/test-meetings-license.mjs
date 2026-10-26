import { generateKeyPairSync, verify } from "node:crypto";
import assert from "node:assert/strict";
import { signLicense } from "../supabase/functions/_shared/meeting-license.mjs";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const license = await signLicense(
  "fixture-user",
  "fixture",
  privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
);
const payload = Buffer.from(license.payload, "base64url"),
  signature = Buffer.from(license.signature, "base64url");
assert(verify(null, payload, publicKey, signature));
assert(!verify(null, Buffer.from("tampered"), publicKey, signature));
const claims = JSON.parse(payload.toString());
assert.equal(claims.userId, "fixture-user");
assert.equal(claims.audience, "echo-meetings");
assert.equal(claims.tier, "pro_lifetime");
assert.equal(claims.exp, undefined);
assert.deepEqual(claims.features, ["meetings"]);
console.log(
  "Licence signing, tamper detection, account binding and non-expiring claims passed.",
);
