import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
function stage(source,destination){const temporary=`${destination}.staging`;cpSync(source,temporary);renameSync(temporary,destination);}
function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  if (result.status !== 0)
    throw new Error(
      `${command} failed (${result.status ?? result.error?.message})`,
    );
  return result.stdout?.trim();
}
export function buildMeetingHelpers({
  universal = false,
  release = false,
  target,
} = {}) {
  if (!["darwin", "win32"].includes(process.platform)) return;
  const windows = process.platform === "win32",
    configuration = release ? "Release" : "Debug";
  const arches = universal
    ? ["arm64", "x86_64"]
    : [
        windows
          ? "x86_64"
          : target?.startsWith("x86_64")
            ? "x86_64"
            : target?.startsWith("aarch64")
              ? "arm64"
              : process.arch === "arm64"
                ? "arm64"
                : "x86_64",
      ];
  const output = join(root, "src-tauri/binaries");
  mkdirSync(output, { recursive: true });
  const products = { "echo-notes": [], "echo-capture": [] };
  for (const arch of arches) {
    const triple = windows
      ? "x86_64-pc-windows-msvc"
      : `${arch === "arm64" ? "aarch64" : arch}-apple-darwin`;
    const build = join(root, `native/notes/.build/${arch}`);
    const options = [
      "-S",
      "native/notes",
      "-B",
      build,
      `-DCMAKE_BUILD_TYPE=${configuration}`,
      `-DGGML_METAL=${!windows && arch === "arm64" ? "ON" : "OFF"}`,
    ];
    if (!windows)
      options.push(
        `-DCMAKE_OSX_ARCHITECTURES=${arch}`,
        "-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0",
      );
    if (process.env.ECHO_LLAMA_SOURCE)
      options.push(
        `-DFETCHCONTENT_SOURCE_DIR_LLAMA=${process.env.ECHO_LLAMA_SOURCE}`,
      );
    run("cmake", options);
    run("cmake", [
      "--build",
      build,
      "--config",
      configuration,
      "--target",
      "echo-notes",
      "--parallel",
      "4",
    ]);
    const notes = join(output, `echo-notes-${triple}${windows ? ".exe" : ""}`);
    stage(
      join(build, windows ? `${configuration}/echo-notes.exe` : "echo-notes"),
      notes,
    );
    products["echo-notes"].push(notes);
    let binary;
    if (windows) {
      const captureBuild = join(root, "native/capture/.build/windows");
      run("cmake", ["-S", "native/capture/windows", "-B", captureBuild]);
      run("cmake", [
        "--build",
        captureBuild,
        "--config",
        configuration,
        "--parallel",
        "4",
      ]);
      binary = join(captureBuild, configuration, "echo-capture.exe");
    } else {
      const args = [
        "build",
        "--package-path",
        "native/capture",
        "-c",
        configuration.toLowerCase(),
        "--arch",
        arch,
      ];
      run("swift", args);
      binary = join(
        run("swift", [...args, "--show-bin-path"], true),
        "echo-capture",
      );
    }
    const capture = join(
      output,
      `echo-capture-${triple}${windows ? ".exe" : ""}`,
    );
    stage(binary, capture);
    products["echo-capture"].push(capture);
  }
  if (universal)
    for (const [name, binaries] of Object.entries(products))
      run("lipo", [
        "-create",
        ...binaries,
        "-output",
        join(output, `${name}-universal-apple-darwin`),
      ]);
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  buildMeetingHelpers({
    universal: process.argv.includes("--universal"),
    release: process.argv.includes("--release"),
  });
