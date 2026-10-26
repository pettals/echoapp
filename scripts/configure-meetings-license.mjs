// Maintainer provisioning only. Never prints the private key or puts it in the repo.
import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2),
  value = (name) => args[args.indexOf(name) + 1];
if (!args.includes("--key-id") || !args.includes("--secrets-file"))
  throw new Error(
    "Usage: node scripts/configure-meetings-license.mjs --key-id <unique-id> --secrets-file <private path outside repo>",
  );
const id = value("--key-id"),
  secretPath = resolve(value("--secrets-file"));
if (!/^[a-zA-Z0-9-]{1,60}$/.test(id))
  throw new Error("Choose a short signing key ID");
if (!relative(root, secretPath).startsWith(".."))
  throw new Error("The secret file must be outside the repository");
const ringPath = join(root, "src-tauri/meeting-license-keys.json"),
  ring = JSON.parse(readFileSync(ringPath, "utf8"));
if (ring[id] || existsSync(secretPath))
  throw new Error(
    "Key ID or secret file already exists; refusing to replace signing material",
  );
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privateDer = privateKey.export({ type: "pkcs8", format: "der" });
const publicDer = publicKey.export({ type: "spki", format: "der" });
writeFileSync(
  secretPath,
  `MEETINGS_LICENSE_KEY_ID=${id}\nMEETINGS_LICENSE_PRIVATE_KEY=${privateDer.toString("base64")}\n`,
  { mode: 0o600, flag: "wx" },
);
ring[id] = publicDer.subarray(-32).toString("base64url");
writeFileSync(ringPath, JSON.stringify(ring, null, 2) + "\n");
console.log(
  "Public verification key added. Upload the private secrets file to Echo's Supabase project, then securely remove that temporary file.",
);
