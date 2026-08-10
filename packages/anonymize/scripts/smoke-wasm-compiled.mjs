#!/usr/bin/env node
/**
 * Compiled single-binary loader guard for the wasm package entry.
 *
 * `bun build --compile` embeds the module graph in a virtual filesystem, and
 * dynamic `import()` resolves against it exclusively — the binding's relative
 * asset URLs (derived from `import.meta.url`) can never reach assets copied
 * onto disk, so `getBinding()` fails inside compiled binaries even when
 * `dist/native/` sits next to the binary. `STLL_ANONYMIZE_ASSET_DIR`
 * redirects asset resolution to a real directory.
 *
 * This smoke compiles a minimal consumer of the built `wasm/dist/wasm.mjs`
 * and asserts both directions: without the override the engine load fails
 * (proving the smoke exercises the class), and with the override a default
 * redaction resolves entities end to end (glue, wasm, prepared package).
 *
 * Prerequisites (same as smoke-wasm-package.mjs):
 *   - `bun run build:native-wasm`
 *   - `bun run build`
 *   - `bun run build:wasm-assets`
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(here);
const entryPath = join(packageRoot, "wasm", "dist", "wasm.mjs");
const nativeAssetsPath = join(packageRoot, "wasm", "dist", "native");

for (const required of [entryPath, join(nativeAssetsPath, "index.js")]) {
  if (!existsSync(required)) {
    throw new Error(
      `missing ${required}; run \`bun run build\` and \`bun run build:wasm-assets\` first`,
    );
  }
}

const workDir = mkdtempSync(join(tmpdir(), "smoke-wasm-compiled-"));
try {
  const consumerPath = join(workDir, "consumer.ts");
  writeFileSync(
    consumerPath,
    [
      `import { redactDefaultText } from ${JSON.stringify(entryPath)};`,
      "",
      'const result = await redactDefaultText("Alice Novak called +420 777 123 456.");',
      "if (result.resolvedEntities.length === 0) {",
      '  throw new Error("compiled binary resolved no entities");',
      "}",
      "console.log(JSON.stringify({ ok: true, entities: result.resolvedEntities.length }));",
    ].join("\n"),
  );

  const binaryPath = join(workDir, "consumer");
  const compile = spawnSync(
    "bun",
    [
      "build",
      "--compile",
      "--target=bun",
      "--outfile",
      binaryPath,
      consumerPath,
    ],
    { stdio: "inherit" },
  );
  if (compile.status !== 0) {
    throw new Error(`bun build --compile exited with status ${compile.status}`);
  }

  // Without the override the loader must fail: a pass here would mean the
  // guard no longer exercises the embedded-filesystem class at all.
  const withoutOverride = spawnSync(binaryPath, [], {
    encoding: "utf8",
    env: { ...process.env, STLL_ANONYMIZE_ASSET_DIR: "" },
  });
  if (withoutOverride.status === 0) {
    throw new Error(
      "compiled consumer unexpectedly loaded the engine without STLL_ANONYMIZE_ASSET_DIR; " +
        "the embedded-filesystem constraint changed — re-evaluate this guard and the override",
    );
  }

  const assetDir = join(workDir, "assets");
  cpSync(nativeAssetsPath, assetDir, { recursive: true });
  const withOverride = spawnSync(binaryPath, [], {
    encoding: "utf8",
    env: { ...process.env, STLL_ANONYMIZE_ASSET_DIR: assetDir },
  });
  if (withOverride.status !== 0) {
    throw new Error(
      `compiled consumer failed with STLL_ANONYMIZE_ASSET_DIR:\n${withOverride.stdout}\n${withOverride.stderr}`,
    );
  }
  const lastLine = withOverride.stdout.trim().split("\n").at(-1) ?? "";
  const parsed = JSON.parse(lastLine);
  if (parsed.ok !== true || typeof parsed.entities !== "number") {
    throw new Error(`unexpected consumer output: ${lastLine}`);
  }

  console.log(
    JSON.stringify({
      event: "smoke-wasm-compiled",
      ok: true,
      entities: parsed.entities,
    }),
  );
} finally {
  rmSync(workDir, { force: true, recursive: true });
}
