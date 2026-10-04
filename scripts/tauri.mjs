#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const tauriBin = join(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tauri.cmd" : "tauri",
);

function hasExplicitConfig(values) {
  const cliArgs = values.includes("--")
    ? values.slice(0, values.indexOf("--"))
    : values;

  return cliArgs.some((value) => {
    return (
      value === "--config" ||
      value === "-c" ||
      value.startsWith("--config=")
    );
  });
}

const finalArgs =
  args[0] === "dev" && !hasExplicitConfig(args)
    ? ["dev", "--config", "src-tauri/tauri.dev.conf.json", ...args.slice(1)]
    : args;

if (args[0] === "dev" && process.platform === "win32") {
  const protocolScript = join(root, "scripts", "register-windows-dev-protocol.ps1");
  const register = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", protocolScript],
    { cwd: root, stdio: "inherit" },
  );
  if (register.status !== 0) {
    process.exit(register.status ?? 1);
  }
}

const child = spawn(tauriBin, finalArgs, {
  cwd: root,
  env: process.env,
  stdio: "inherit",
  shell: process.platform === "win32",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
