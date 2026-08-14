/**
 * Download the ONNX models the local OCR provider runs, verifying each
 * against a pinned SHA-256 before it is written. Idempotent: a file that
 * already matches its digest is left untouched, so repeated runs (and
 * Docker layer rebuilds) do no network work.
 *
 * Usage:  bun run src/scripts/fetch-ocr-models.ts [targetDir]
 *   targetDir defaults to ./ocr-models (relative to apps/api).
 */

import { panic, Result } from "better-result";
import path from "node:path";

import { OCR_LOCAL_MODEL_FILES } from "@/api/lib/document-processing-contract";
import { safeOutboundFetchBytes } from "@/api/lib/safe-outbound-fetch";

const MODEL_SOURCES = {
  [OCR_LOCAL_MODEL_FILES.detection]: {
    url: "https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_det_onnx/resolve/main/inference.onnx",
    sha256: "a431985659dc921974177a95adcfbb90fd9e51989a5e04d70d0b75f597b6e61d",
  },
  [OCR_LOCAL_MODEL_FILES.recognition]: {
    url: "https://huggingface.co/PaddlePaddle/latin_PP-OCRv5_mobile_rec_onnx/resolve/main/inference.onnx",
    sha256: "7888113072263cb471b93f66dd5e2ad70548dc526fa1ace760d0d973dd121498",
  },
} as const satisfies Record<
  (typeof OCR_LOCAL_MODEL_FILES)[keyof typeof OCR_LOCAL_MODEL_FILES],
  { url: string; sha256: string }
>;

const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;

const sha256Hex = (bytes: ArrayBuffer): string =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

const targetDir = path.resolve(process.argv[2] ?? "ocr-models");

const fetchModel = async (
  fileName: string,
  source: { url: string; sha256: string },
): Promise<void> => {
  const targetPath = path.join(targetDir, fileName);
  const existing = Bun.file(targetPath);
  if (await existing.exists()) {
    const digest = sha256Hex(await existing.arrayBuffer());
    if (digest === source.sha256) {
      console.log(`ok (cached): ${fileName}`);
      return;
    }
    panic(
      `${targetPath} exists with digest ${digest}; expected ${source.sha256}. Remove the file to re-download.`,
    );
  }

  const response = await safeOutboundFetchBytes({
    maxBytes: DOWNLOAD_MAX_BYTES,
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    url: source.url,
  });
  if (Result.isError(response)) {
    panic(`download of ${fileName} failed: ${response.error.message}`);
  }
  if (!response.value.ok) {
    panic(`download of ${fileName} failed with HTTP ${response.value.status}`);
  }
  const bytes = response.value.body;
  const digest = sha256Hex(bytes);
  if (digest !== source.sha256) {
    panic(
      `${fileName} digest ${digest} does not match the pinned ${source.sha256}`,
    );
  }
  await Bun.write(targetPath, bytes);
  console.log(`ok (downloaded): ${fileName} (${bytes.byteLength} bytes)`);
};

await Promise.all(
  Object.entries(MODEL_SOURCES).map(
    async ([fileName, source]) => await fetchModel(fileName, source),
  ),
);
