import { getAnalytics } from "@/lib/analytics/provider";

// oxlint-disable-next-line import/default -- Vite ?worker&url import returns the emitted worker script URL as default export
import anonymizeChatWorkerUrl from "../../workers/anonymize-chat-worker?worker&url";
import { createAnonymizeChatWorkerClient } from "./anonymize-chat-worker-client.logic";

/**
 * Main-thread client for the chat-input anonymization Web Worker.
 *
 * One worker is shared per tab (lazy-created on first use). All
 * pending requests are tracked by a numeric id so multiple
 * concurrent calls (e.g. live preview + sent-message render) can
 * be in flight without crossing wires.
 */

const ANONYMIZE_REQUEST_TIMEOUT_MS = 30_000;
const MAX_PENDING_ANONYMIZE_REQUESTS = 32;

/**
 * Create the dedicated module worker.
 *
 * A cross-origin-isolated document (COOP + COEP, which the web runtime sets
 * for wasm memory) subjects a dedicated worker's script response to an
 * embedder-policy check: the response must itself carry a compatible COEP
 * header. The built worker script is a static asset whose response headers
 * depend on whichever host serves it, so a direct `new Worker(url)` fails
 * closed (an `error` event at boot, no highlights ever) when that host omits
 * the header. A same-origin blob bootstrap that `import`s the script inherits
 * the document's policy instead of re-checking response headers, keeping
 * worker boot independent of asset-host header configuration.
 *
 * Non-isolated contexts skip that check but may forbid blob workers via CSP
 * (the desktop webview's `default-src 'self'` does), so each branch uses the
 * one constructor that works in its context.
 */
const createAnonymizeChatWorker = (): Worker => {
  if (!globalThis.crossOriginIsolated) {
    return new Worker(anonymizeChatWorkerUrl, { type: "module" });
  }
  const scriptUrl = new URL(anonymizeChatWorkerUrl, globalThis.location.href)
    .href;
  const bootstrapBlob = new Blob([`import ${JSON.stringify(scriptUrl)};`], {
    type: "text/javascript",
  });
  const bootstrapUrl = URL.createObjectURL(bootstrapBlob);
  try {
    return new Worker(bootstrapUrl, { type: "module" });
  } finally {
    // Revoking immediately after construction is safe — the constructor
    // pins the blob before this line runs (Vite's own inline-worker helper
    // uses the same pattern).
    URL.revokeObjectURL(bootstrapUrl);
  }
};

const client = createAnonymizeChatWorkerClient({
  createWorker: createAnonymizeChatWorker,
  requestTimeoutMs: ANONYMIZE_REQUEST_TIMEOUT_MS,
  maxPendingRequests: MAX_PENDING_ANONYMIZE_REQUESTS,
});

// oxlint-disable-next-line @typescript-eslint/promise-function-async -- the body is the Promise; an inner async wrapper would just add a microtask
export const anonymizeChatTextInWorker = ({
  text,
  workspaceId,
  excludedCanonicals,
}: {
  text: string;
  workspaceId: string;
  /**
   * Surface forms the caller has marked as never-anonymize for
   * this run. Forwarded verbatim to `runChatAnonPipeline`, which
   * applies its own NFKC + case-insensitive comparison.
   */
  excludedCanonicals?: readonly string[];
}) =>
  client.anonymize(
    excludedCanonicals === undefined
      ? { text, workspaceId }
      : { text, workspaceId, excludedCanonicals },
  );

let warmedUp = false;

/**
 * Boot the anonymization worker without waiting for the first
 * keystroke. The cold path is heavy in dev: Vite has to compile
 * the worker module, fetch `@stll/anonymize-wasm` (wasm binary)
 * and `@stll/anonymize-data` (name dictionary JSONs), and the
 * worker then runs `loadNameDictionaries()` to parse them. Doing
 * that lazily on the first preview means the user types a name,
 * waits ~200 ms for the debounce, then sits through several
 * seconds of cold-start before the highlights paint.
 *
 * Calling this when the anonymization layer mounts pushes that
 * one-time cost behind the scenes. The empty-text branch in the
 * worker resolves instantly *after* the dictionaries finish
 * loading, so by the time the user pauses typing the worker is
 * warm and the real call returns in milliseconds.
 *
 * Idempotent — only the first call kicks the worker.
 */
export const warmupChatAnonymizeWorker = (): void => {
  if (warmedUp) {
    return;
  }
  warmedUp = true;
  // Send a single-character payload (not empty) so the worker
  // exits its "blank input" fast-path and actually runs
  // `loadNameDictionaries()` + the wasm pipeline once. The `"x"`
  // here has no semantic meaning; we just need *some* token so
  // the heavy initialisation happens before the user types.
  anonymizeChatTextInWorker({ text: "x", workspaceId: "warmup" }).catch(
    (error: unknown) => {
      // Warmup is non-blocking; record the failure and allow the next mount
      // to retry a transient worker crash.
      getAnalytics().captureError(error);
      warmedUp = false;
    },
  );
};
