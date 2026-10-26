import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packagePath = join(root, "native/bark");

function makeReadable(path) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) return;
  chmodSync(path, (metadata.mode & 0o777) | (metadata.isDirectory() ? 0o755 : 0o644));
  if (metadata.isDirectory())
    for (const child of readdirSync(path)) makeReadable(join(path, child));
}

function run(command, args, capture = false) {
  const result = spawnSync(command, args, { cwd: root, stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit", encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.error?.message})`);
  return result.stdout?.trim();
}

export function buildBarkHelper({ universal = false, release = false, target } = {}) {
  if (process.platform !== "darwin") return;
  const configuration = release ? "release" : "debug";
  const architecture = target?.startsWith("x86_64") ? "x86_64" : target?.startsWith("aarch64") ? "arm64" : process.arch === "arm64" ? "arm64" : "x86_64";
  const architectures = universal ? ["arm64", "x86_64"] : [architecture];
  const output = join(root, "src-tauri/binaries");
  mkdirSync(output, { recursive: true });
  const binaries = [];
  for (const arch of architectures) {
    const args = ["build", "--package-path", packagePath, "-c", configuration, "--arch", arch];
    run("swift", args);
    const binPath = run("swift", [...args, "--show-bin-path"], true);
    const triple = `${arch === "arm64" ? "aarch64" : arch}-apple-darwin`;
    const destination = join(output, `echo-bark-${triple}`);
    cpSync(join(binPath, "echo-bark"), destination);
    binaries.push(destination);
    // SwiftPM Bundle.module looks for resources in Bundle.main.resourceURL.
    for (const resource of readdirSync(binPath).filter((name) => name.endsWith(".bundle"))) {
      const destination = join(output, resource);
      rmSync(destination, { recursive: true, force: true });
      cpSync(join(binPath, resource), destination, { recursive: true });
      makeReadable(destination);
    }
  }
  if (universal) run("lipo", ["-create", ...binaries, "-output", join(output, "echo-bark-universal-apple-darwin")]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  buildBarkHelper({ universal: process.argv.includes("--universal"), release: process.argv.includes("--release") });
}
