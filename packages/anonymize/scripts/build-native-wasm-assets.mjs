#!/usr/bin/env node
/** Assemble the browser package assets emitted by wasm-bindgen. */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertWasmArtifactSize,
  WASM_RUNTIME_ARTIFACTS,
} from "./wasm-artifact-policy.mjs";

if (process.env.STELLA_ANONYMIZE_SKIP_WASM_BUILD === "1") {
  console.log(
    "build-native-wasm-assets: skipped (STELLA_ANONYMIZE_SKIP_WASM_BUILD=1)",
  );
  process.exit(0);
}

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const wasmBuildDir = join(packageRoot, "native-wasm-dist");
const outputDir = join(packageRoot, "wasm", "dist", "native");
const defaultLanguages = ["cs", "de", "en"];
const languages = languageListFromEnv(
  process.env.STELLA_ANONYMIZE_WASM_PACKAGE_LANGUAGES,
  defaultLanguages,
);

if (!existsSync(wasmBuildDir)) {
  throw new Error(
    `Missing ${wasmBuildDir}. Run "bun run build:native-wasm" first.`,
  );
}
if (!existsSync(join(packageRoot, "wasm", "dist", "wasm.mjs"))) {
  throw new Error('Missing wasm/dist/wasm.mjs. Run "bun run build" first.');
}

// This directory contains generated release assets only. Recreating it makes
// the package closed over the current generator output: an obsolete loader or
// worker from an older build cannot survive and be published accidentally.
rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });
const glue = WASM_RUNTIME_ARTIFACTS.map((artifact) => copyArtifact(artifact));

const packages = [];
const defaultPackage = join(outputDir, "native-pipeline.stlanonpkg");
buildCompressedPackage(["--out", defaultPackage, "--default-dictionaries"]);
packages.push(packageInfo(defaultPackage));
for (const language of languages) {
  const output = join(outputDir, `native-pipeline.${language}.stlanonpkg`);
  buildCompressedPackage([
    "--out",
    output,
    "--default-dictionaries",
    "--language",
    language,
  ]);
  packages.push(packageInfo(output));
}

console.log(
  JSON.stringify(
    { event: "native-wasm-assets", outputDir, glue, packages },
    null,
    2,
  ),
);

function copyArtifact({ source: file, maxBytes }) {
  const source = join(wasmBuildDir, file);
  if (!existsSync(source)) {
    throw new Error(`Missing wasm artifact: ${source}`);
  }
  const destination = join(outputDir, file);
  copyFileSync(source, destination);
  const bytes = statSync(destination).size;
  assertWasmArtifactSize({ file, bytes, maxBytes });
  return { file, bytes, maxBytes };
}

function buildCompressedPackage(args) {
  execFileSync(
    process.execPath,
    [
      join(packageRoot, "scripts", "build-native-pipeline-package.mjs"),
      "--compressed",
      ...args,
    ],
    { cwd: packageRoot, stdio: "inherit" },
  );
}

function packageInfo(file) {
  return { file: basename(file), bytes: statSync(file).size };
}

function languageListFromEnv(value, defaults) {
  if (value === undefined) {
    return defaults;
  }
  if (value.trim().length === 0) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
    .filter((entry, index, entries) => entries.indexOf(entry) === index);
}
