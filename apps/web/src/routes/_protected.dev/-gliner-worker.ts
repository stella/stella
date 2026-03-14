import { Gliner } from "@/lib/anonymize/gliner/gliner";
import type { ExecutionProvider } from "@/lib/anonymize/gliner/gliner";

type WorkerMessage =
  | {
      type: "init";
      modelPath: string;
      tokenizerPath?: string;
    }
  | {
      type: "inference";
      texts: string[];
      entities: string[];
      threshold: number;
    };

type WorkerResponse =
  | { type: "init-progress"; message: string }
  | {
      type: "download-progress";
      downloadedMb: number;
      totalMb: number;
      percent: number;
    }
  | { type: "init-done"; backend: string }
  | {
      type: "inference-done";
      results: {
        start: number;
        end: number;
        label: string;
        text: string;
        score: number;
      }[][];
      durationMs: number;
    }
  | { type: "error"; message: string };

let gliner: Gliner | null = null;

const detectBackend = async (): Promise<{
  provider: ExecutionProvider;
  multiThread: boolean;
  label: string;
}> => {
  // WebGPU: best for fp16 models (native fp16 shader support).
  // Only skip for int8/uint8 models where WASM is faster.
  if ("gpu" in navigator) {
    try {
      // eslint-disable-next-line typescript/no-unsafe-assignment, no-unsafe-call -- WebGPU API not typed in workers
      const adapter = await navigator.gpu.requestAdapter();
      // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- WebGPU adapter may be null
      if (adapter) {
        return {
          provider: "webgpu",
          multiThread: false,
          label: "WebGPU",
        };
      }
    } catch {
      // WebGPU not available, fall through
    }
  }

  // Multi-threaded WASM if cross-origin isolated
  if (
    typeof globalThis !== "undefined" &&
    "crossOriginIsolated" in globalThis &&
    globalThis.crossOriginIsolated
  ) {
    return {
      provider: "wasm",
      multiThread: true,
      label: "WASM (multi-threaded)",
    };
  }

  // Single-threaded WASM fallback
  return {
    provider: "wasm",
    multiThread: false,
    label: "WASM (single-threaded)",
  };
};

const CACHE_NAME = "gliner-models";

const downloadWithProgress = async (
  url: string,
  post: (msg: WorkerResponse) => void,
): Promise<Uint8Array> => {
  // Check Cache API first
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(url);

  if (cached) {
    post({
      type: "init-progress",
      message: "Loading model from cache...",
    });
    const buffer = await cached.arrayBuffer();
    post({
      type: "init-progress",
      message: `Loaded from cache (${(buffer.byteLength / (1024 * 1024)).toFixed(0)} MB)`,
    });
    return new Uint8Array(buffer);
  }

  // Download with progress
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Model download failed: ${response.status} ${response.statusText}`,
    );
  }
  const contentLength = response.headers.get("content-length");
  const totalBytes = contentLength ? Number(contentLength) : 0;
  const totalMb = totalBytes / (1024 * 1024);

  if (!response.body) {
    post({
      type: "init-progress",
      message: `Downloading model (${totalMb.toFixed(0)} MB)...`,
    });
    const buffer = await response.arrayBuffer();
    // Cache for next time
    await cache.put(url, new Response(buffer.slice(0)));
    return new Uint8Array(buffer);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let downloaded = 0;
  let lastReportedPercent = -1;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    chunks.push(value);
    downloaded += value.length;

    const downloadedMb = downloaded / (1024 * 1024);
    const percent =
      totalBytes > 0 ? Math.round((downloaded / totalBytes) * 100) : 0;

    if (percent > lastReportedPercent) {
      lastReportedPercent = percent;
      post({
        type: "download-progress",
        downloadedMb: Math.round(downloadedMb * 10) / 10,
        totalMb: Math.round(totalMb * 10) / 10,
        percent,
      });
    }
  }

  // Merge chunks
  const result = new Uint8Array(downloaded);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  // Cache for next time
  await cache.put(url, new Response(result.buffer.slice(0)));

  return result;
};

const handleInit = async (modelPath: string, tokenizerPath?: string) => {
  // eslint-disable-next-line unicorn/require-post-message-target-origin -- Worker.postMessage has no targetOrigin
  const post = (msg: WorkerResponse) => self.postMessage(msg);

  try {
    const backend = await detectBackend();
    post({
      type: "init-progress",
      message: `Detected backend: ${backend.label}`,
    });

    // Download model with progress tracking
    post({
      type: "init-progress",
      message: "Downloading model...",
    });
    const modelBytes = await downloadWithProgress(modelPath, post);
    post({
      type: "init-progress",
      message:
        `Download complete ` +
        `(${(modelBytes.length / (1024 * 1024)).toFixed(0)} MB). ` +
        `Initializing ONNX session...`,
    });

    const createGliner = (provider: ExecutionProvider, multiThread: boolean) =>
      new Gliner({
        tokenizerPath: tokenizerPath ?? "onnx-community/gliner_multi_pii-v1",
        onnxSettings: {
          modelPath: modelBytes,
          executionProvider: provider,
          multiThread,
          maxThreads: 4,
        },
        maxWidth: 12,
      });

    // Try preferred backend; fall back to WASM if it fails
    // (e.g., Edge's WebGPU ONNX support is incomplete).
    let usedLabel = backend.label;
    gliner = createGliner(backend.provider, backend.multiThread);
    try {
      await gliner.initialize();
    } catch (primaryError) {
      if (backend.provider !== "wasm") {
        post({
          type: "init-progress",
          message:
            `${backend.label} failed ` +
            `(${primaryError instanceof Error ? primaryError.message : String(primaryError)}), ` +
            `falling back to WASM...`,
        });
        usedLabel = "WASM (fallback)";
        gliner = createGliner("wasm", false);
        await gliner.initialize();
      } else {
        throw primaryError;
      }
    }

    post({ type: "init-done", backend: usedLabel });
  } catch (error) {
    post({
      type: "error",
      message: `Init failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
};

const handleInference = async (
  texts: string[],
  entities: string[],
  threshold: number,
) => {
  // eslint-disable-next-line unicorn/require-post-message-target-origin -- Worker.postMessage has no targetOrigin
  const post = (msg: WorkerResponse) => self.postMessage(msg);

  if (gliner === null) {
    post({ type: "error", message: "Model not initialized" });
    return;
  }

  try {
    // Track which input indices have valid (non-empty) text
    const validIndices: number[] = [];
    const validTexts: string[] = [];
    for (let i = 0; i < texts.length; i++) {
      if (texts[i].trim().length > 0) {
        validIndices.push(i);
        validTexts.push(texts[i]);
      }
    }

    if (validTexts.length === 0) {
      post({
        type: "inference-done",
        results: texts.map(() => []),
        durationMs: 0,
      });
      return;
    }

    const start = performance.now();
    const raw = await gliner.inference({
      texts: validTexts,
      entities,
      flatNer: false,
      threshold,
      multiLabel: false,
    });
    const durationMs = Math.round(performance.now() - start);

    type ResultEntry = {
      start: number;
      end: number;
      label: string;
      text: string;
      score: number;
    };

    // Map results back to original input indices
    const results: ResultEntry[][] = texts.map(() => []);
    for (let i = 0; i < raw.length; i++) {
      results[validIndices[i]] = raw[i].map((e) => ({
        start: e.start,
        end: e.end,
        label: e.label,
        text: e.spanText,
        score: e.score,
      }));
    }

    post({ type: "inference-done", results, durationMs });
  } catch (error) {
    post({
      type: "error",
      message: `Inference failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
};

self.addEventListener("message", (event: MessageEvent<WorkerMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case "init":
      handleInit(msg.modelPath, msg.tokenizerPath).catch(() => {
        /* fire-and-forget */
      });
      break;
    case "inference":
      handleInference(msg.texts, msg.entities, msg.threshold).catch(() => {
        /* fire-and-forget */
      });
      break;
    default:
      break;
  }
});
