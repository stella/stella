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

import { OCR_LOCAL_MODEL_FILES } from "@/api/lib/document-processing-contract";
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

// Unlike the presence checks above, the local OCR worker is spawned for
// real on a minimal blank-page PDF: it exercises the pdfium wasm, the
// onnxruntime native binding at its bundle-relative location, and the
// pinned models, exactly as a document-processing run would.
await probe("local ocr worker", async () => {
  const workerDir =
    runtimeWorkerDir() ??
    panic("STELLA_WORKER_DIR must be set for the image smoke");
  const modelDir =
    process.env["DOCUMENT_OCR_MODEL_DIR"] ??
    panic("DOCUMENT_OCR_MODEL_DIR must be set for the image smoke");
  const missingModels = (
    await Promise.all(
      Object.values(OCR_LOCAL_MODEL_FILES).map(async (file) =>
        (await Bun.file(path.join(modelDir, file)).exists()) ? null : file,
      ),
    )
  ).filter((file) => file !== null);
  if (missingModels.length > 0) {
    panic(`missing OCR models: ${missingModels.join(", ")}`);
  }

  const blankPagePdf = [
    "%PDF-1.4",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj",
    "trailer << /Size 4 /Root 1 0 R >>",
  ].join("\n");
  const subprocess = Bun.spawn(
    [
      "bun",
      "run",
      path.join(workerDir, RUNTIME_WORKER_FILES.ocrLocal),
      modelDir,
    ],
    {
      stdin: new Blob([blankPagePdf]),
      stdout: "pipe",
      stderr: "pipe",
      // A hung worker must fail the image build, not stall it.
      timeout: 120_000,
    },
  );
  const [output, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  if (exitCode !== 0) {
    panic(`local ocr worker exited with ${exitCode}: ${stderr.trim()}`);
  }
  const parsed: unknown = JSON.parse(output);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("pages" in parsed) ||
    !Array.isArray(parsed.pages) ||
    parsed.pages.length !== 1
  ) {
    panic("local ocr worker returned an unexpected result shape");
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
