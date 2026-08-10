/**
 * Runtime-asset smoke for the compiled API image.
 *
 * The container ships hand-copied assets the binary loads lazily: the
 * anonymization engine's native glue and WASM, the quickjs sandbox WASM, the
 * compiled YARA rules, the bundled workers with their WASM sidecars, and the
 * OCR PDF font. Nothing else exercises them before the first request that
 * needs them. apps/api/Dockerfile compiles this entry like the server (so its
 * bundled asset URLs resolve the same way) and runs it in a throwaway stage
 * on top of the runner filesystem; a missing or unloadable asset fails the
 * image build.
 *
 * Self-contained on purpose: no env module, no DB client. Each probe drives
 * the real loader rather than checking existence, except the worker bundles
 * (spawning them needs request-shaped input), where presence of the exact
 * files the runtime resolves is the contract.
 */

import { panic } from "better-result";
import path from "node:path";
import { newAsyncContext } from "quickjs-emscripten";

import { getBinding, isNativeAnonymizeBinding } from "@stll/anonymize-wasm";

import { yaraRuleFileCount, yaraScanner } from "@/api/lib/file-scan/yara";
import {
  RUNTIME_WORKER_FILES,
  RUNTIME_WORKER_SIDECAR_FILES,
  runtimeOcrPdfFontPath,
  runtimeWorkerDir,
} from "@/api/lib/runtime-worker-path";

const probe = async (label: string, run: () => Promise<void>) => {
  await run();
  console.log(`image-smoke ok: ${label}`);
};

await probe("quickjs sandbox wasm", async () => {
  const context = await newAsyncContext();
  const handle = context.unwrapResult(context.evalCode("6 * 7"));
  const value = context.getNumber(handle);
  handle.dispose();
  context.dispose();
  if (value !== 42) {
    panic(`quickjs evaluated 6 * 7 to ${value}`);
  }
});

await probe("yara rules", async () => {
  if (yaraRuleFileCount === 0) {
    panic("no YARA rule files were compiled; rules directory missing?");
  }
  const matches = await yaraScanner.scan(
    new TextEncoder().encode("image smoke probe"),
  );
  if (!Array.isArray(matches)) {
    panic("yara scan returned no match list");
  }
});

await probe("runtime worker bundles", async () => {
  const workerDir =
    runtimeWorkerDir() ??
    panic("STELLA_WORKER_DIR must be set for the image smoke");
  const expected = [
    ...Object.values(RUNTIME_WORKER_FILES),
    ...RUNTIME_WORKER_SIDECAR_FILES,
  ];
  const missing = (
    await Promise.all(
      expected.map(async (file) =>
        (await Bun.file(path.join(workerDir, file)).exists()) ? null : file,
      ),
    )
  ).filter((file) => file !== null);
  if (missing.length > 0) {
    panic(`runtime worker dir is missing: ${missing.join(", ")}`);
  }
});

await probe("ocr pdf font", async () => {
  const fontPath =
    runtimeOcrPdfFontPath() ??
    panic("STELLA_OCR_PDF_FONT_PATH must be set for the image smoke");
  if (!(await Bun.file(fontPath).exists())) {
    panic(`missing OCR PDF font at ${fontPath}`);
  }
});

// Requires STLL_ANONYMIZE_ASSET_DIR (set by the Dockerfile): the loader's
// glue is loaded via ESM import(), which a compiled binary resolves against
// its embedded filesystem only, unlike the fs-based probes above.
await probe("anonymize-wasm native engine", async () => {
  const binding = await getBinding();
  if (!isNativeAnonymizeBinding(binding)) {
    panic("anonymize-wasm getBinding() returned an unexpected binding shape");
  }
});

console.log("image-smoke ok: all runtime assets loadable");
