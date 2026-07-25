#!/usr/bin/env node
/** Build the browser-native, single-thread wasm-bindgen adapter. */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.STELLA_ANONYMIZE_SKIP_WASM_BUILD === "1") {
  console.log(
    "build-native-wasm: skipped (STELLA_ANONYMIZE_SKIP_WASM_BUILD=1)",
  );
  process.exit(0);
}

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(packageRoot));
const outputDir = join(packageRoot, "native-wasm-dist");
const wasmPath = join(
  repoRoot,
  "target",
  "wasm32-unknown-unknown",
  "wasm-release",
  "stella_anonymize_wasm.wasm",
);
const expectedWasmBindgenVersion = "wasm-bindgen 0.2.126";
let actualWasmBindgenVersion;
try {
  actualWasmBindgenVersion = execFileSync("wasm-bindgen", ["--version"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
} catch (cause) {
  throw new Error(`${expectedWasmBindgenVersion} is required`, { cause });
}
if (actualWasmBindgenVersion !== expectedWasmBindgenVersion) {
  throw new Error(
    `Expected ${expectedWasmBindgenVersion}, got ${actualWasmBindgenVersion}`,
  );
}

// wasm-bindgen does not own files left by an earlier generator. Recreate the
// generated directory so obsolete loaders can never leak into later builds.
rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

execFileSync(
  "cargo",
  [
    "build",
    "-p",
    "stella-anonymize-wasm",
    "--target",
    "wasm32-unknown-unknown",
    "--profile",
    "wasm-release",
    "--locked",
  ],
  { cwd: repoRoot, stdio: "inherit" },
);
execFileSync(
  "wasm-bindgen",
  [
    wasmPath,
    "--target",
    "web",
    "--no-typescript",
    "--out-dir",
    outputDir,
    "--out-name",
    "index",
  ],
  { cwd: repoRoot, stdio: "inherit" },
);

console.log("build-native-wasm: emitted single-thread wasm-bindgen assets");
