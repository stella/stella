import * as v from "valibot";

import {
  resolveRuntimeWorkerPath,
  RUNTIME_WORKER_FILES,
} from "@/api/lib/runtime-worker-path";

export const PDF_WORKER_PARSE_ERROR_EXIT_CODE = 65;

export const pdfWorkerPath = () =>
  resolveRuntimeWorkerPath({
    outputFile: RUNTIME_WORKER_FILES.pdf,
    sourceDir: import.meta.dir,
    sourceFile: "pdf-worker.ts",
  });

export const PDF_WORKER_OPERATION = {
  encryption: "encryption",
  textLines: "text-lines",
} as const;

export const pdfWorkerOperationSchema = v.picklist(
  Object.values(PDF_WORKER_OPERATION),
);

export const pdfTextLinesSchema = v.array(v.string());
