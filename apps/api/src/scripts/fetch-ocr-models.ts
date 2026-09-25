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
import { fetchBytesFollowingRedirects } from "@/api/lib/redirect-fetch";
import { safeOutboundFetchBytes } from "@/api/lib/safe-outbound-fetch";

// Each URL names a repository commit, not a branch, so the bytes behind it
// cannot move; the digest still guards the transfer.
const MODEL_SOURCES = {
  [OCR_LOCAL_MODEL_FILES.detection]: {
    url: "https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_det_onnx/resolve/e6f4fa85f00e168c862bc462aebca69eef9b3d3d/inference.onnx",
    sha256: "a431985659dc921974177a95adcfbb90fd9e51989a5e04d70d0b75f597b6e61d",
  },
  [OCR_LOCAL_MODEL_FILES.recognition]: {
    url: "https://huggingface.co/PaddlePaddle/latin_PP-OCRv5_mobile_rec_onnx/resolve/89d3a50e2c27e2e7cceeab0e944c25c807d5db4f/inference.onnx",
    sha256: "7888113072263cb471b93f66dd5e2ad70548dc526fa1ace760d0d973dd121498",
  },
} as const satisfies Record<
  (typeof OCR_LOCAL_MODEL_FILES)[keyof typeof OCR_LOCAL_MODEL_FILES],
  { url: string; sha256: string }
>;

const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;
const MAX_REDIRECT_HOPS = 4;
const DOWNLOAD_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 5000;

const sha256Hex = (bytes: ArrayBuffer): string =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

const targetDir = path.resolve(process.argv[2] ?? "ocr-models");

const isTransientStatus = (status: number): boolean =>
  status === 408 || status === 429 || status >= 500;

// A transport error or a transient status is retried with backoff, up to
// DOWNLOAD_ATTEMPTS; any other status fails at once.
const download = async (
  fileName: string,
  url: string,
  attempt = 1,
): Promise<ArrayBuffer> => {
  // Hugging Face `resolve` URLs redirect to the object host, so follow a
  // bounded chain manually: every hop re-runs the safe-outbound target
  // validation instead of trusting the redirect blindly.
  const response = await fetchBytesFollowingRedirects({
    url,
    maxHops: MAX_REDIRECT_HOPS,
    fetchBytes: async (target) =>
      await safeOutboundFetchBytes({
        maxBytes: DOWNLOAD_MAX_BYTES,
        redirect: "manual",
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        url: target,
      }),
  });
  if (Result.isOk(response) && response.value.ok) {
    return response.value.body;
  }
  const failure = Result.isError(response)
    ? response.error.message
    : `HTTP ${response.value.status}`;
  const transient =
    Result.isError(response) || isTransientStatus(response.value.status);
  if (!transient || attempt >= DOWNLOAD_ATTEMPTS) {
    panic(
      `download of ${fileName} failed after ${attempt} attempt(s): ${failure}`,
    );
  }
  const delayMs = RETRY_BASE_DELAY_MS * 3 ** (attempt - 1);
  console.warn(
    `retrying ${fileName} in ${delayMs} ms (attempt ${attempt}/${DOWNLOAD_ATTEMPTS}): ${failure}`,
  );
  await Bun.sleep(delayMs);
  return await download(fileName, url, attempt + 1);
};

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

  const bytes = await download(fileName, source.url);
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
