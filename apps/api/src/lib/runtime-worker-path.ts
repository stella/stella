import path from "node:path";

const WORKER_DIR_ENV = "STELLA_WORKER_DIR";
const OCR_PDF_FONT_PATH_ENV = "STELLA_OCR_PDF_FONT_PATH";

// Bundled worker entrypoints the API spawns at runtime. In the container
// image they live in STELLA_WORKER_DIR (built by apps/api/Dockerfile); in dev
// each call site falls back to its co-located source file. Call sites name
// their bundle through this map (`RuntimeWorkerFile` narrows the parameter),
// so the image smoke probe (scripts/image-smoke.ts) verifies exactly the set
// the runtime can load.
export const RUNTIME_WORKER_FILES = {
  extraction: "extraction-worker.js",
  officeEvidence: "office-evidence-worker.js",
  ocrSearchablePdf: "ocr-searchable-pdf-worker.js",
  pdf: "pdf-worker.js",
} as const;

export type RuntimeWorkerFile =
  (typeof RUNTIME_WORKER_FILES)[keyof typeof RUNTIME_WORKER_FILES];

// Sidecar assets the worker bundles load relative to their own location;
// apps/api/Dockerfile copies them into the same runtime worker directory.
export const RUNTIME_WORKER_SIDECAR_FILES = [
  "pptx_parser_bg.wasm",
  "xlsx_parser_bg.wasm",
] as const;

export const runtimeWorkerDir = (): string | undefined =>
  process.env[WORKER_DIR_ENV];

export const runtimeOcrPdfFontPath = (): string | undefined =>
  process.env[OCR_PDF_FONT_PATH_ENV];

export const resolveRuntimeWorkerPath = ({
  outputFile,
  sourceDir,
  sourceFile,
}: {
  outputFile: RuntimeWorkerFile;
  sourceDir: string;
  sourceFile: string;
}): string => {
  const workerDir = runtimeWorkerDir();
  if (workerDir) {
    return path.resolve(workerDir, outputFile);
  }

  return path.resolve(sourceDir, sourceFile);
};

export const resolveOcrPdfFontPath = (localPath: string): string =>
  runtimeOcrPdfFontPath() || localPath;
