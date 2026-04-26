import { transformUnknownError } from "@/lib/errors/utils";

const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR_MIN = 500;
const DEFAULT_RETRY_AFTER_S = 60;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = [1000, 2000, 4000] as const;

type UploadState =
  | "idle"
  | "running"
  | "paused"
  | "rate-limited"
  | "cancelled"
  | "done";

type UploadFn<T> = (file: File, signal: AbortSignal) => Promise<T>;

type FailedUpload = {
  file: File;
  error: Error;
};

type ProgressEvent = {
  completed: number;
  failed: number;
  total: number;
};

type EventMap<T> = {
  progress: ProgressEvent;
  done: {
    completed: T[];
    failed: FailedUpload[];
    cancelled: boolean;
  };
  "rate-limited": { retryAfterS: number };
  resumed: null;
  "state-change": UploadState;
};

type EventHandler<T> = (data: T) => void;

type ListenerMap<T> = {
  [K in keyof EventMap<T>]: Set<EventHandler<EventMap<T>[K]>>;
};

const sleep = async (ms: number) =>
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Concurrent upload queue with 429-awareness, pause,
 * cancel, and per-file retry.
 *
 * Framework-agnostic: no React dependency.
 */
export class UploadQueue<T> {
  private state: UploadState = "idle";
  private pending: File[] = [];
  private inflight = new Map<File, AbortController>();
  private completed: T[] = [];
  private failed: FailedUpload[] = [];
  private total = 0;
  private retrying = 0;
  private concurrency: number;
  private uploadFn: UploadFn<T>;
  private rateLimitTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners: ListenerMap<T> = {
    done: new Set(),
    progress: new Set(),
    "rate-limited": new Set(),
    resumed: new Set(),
    "state-change": new Set(),
  };

  constructor(uploadFn: UploadFn<T>, concurrency = 5) {
    this.uploadFn = uploadFn;
    this.concurrency = concurrency;
  }

  getState(): UploadState {
    return this.state;
  }

  getProgress(): ProgressEvent {
    return {
      completed: this.completed.length,
      failed: this.failed.length,
      total: this.total,
    };
  }

  getFailedFiles(): FailedUpload[] {
    return [...this.failed];
  }

  on<K extends keyof EventMap<T>>(
    event: K,
    handler: EventHandler<EventMap<T>[K]>,
  ): () => void {
    const handlers = this.listeners[event];
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  }

  private emit<K extends keyof EventMap<T>>(event: K, data: EventMap<T>[K]) {
    const handlers = this.listeners[event];
    for (const handler of handlers) {
      handler(data);
    }
  }

  private setState(next: UploadState) {
    this.state = next;
    this.emit("state-change", next);
  }

  /**
   * Enqueue files and start processing. Can only be called
   * when idle or done.
   */
  enqueue(files: File[]) {
    if (this.state !== "idle" && this.state !== "done") {
      return;
    }

    this.pending = [...files];
    this.inflight.clear();
    this.completed = [];
    this.failed = [];
    this.total = files.length;

    this.setState("running");
    this.emitProgress();
    this.pump();
  }

  /** Pause processing. In-flight requests complete; pending
   *  files are held until `resume()`. Not yet wired to UI. */
  pause() {
    if (this.state !== "running") {
      return;
    }
    this.setState("paused");
  }

  resume() {
    if (this.state !== "paused" && this.state !== "rate-limited") {
      return;
    }
    if (this.rateLimitTimer !== null) {
      clearTimeout(this.rateLimitTimer);
      this.rateLimitTimer = null;
    }
    this.setState("running");
    this.emit("resumed", null);
    this.pump();
  }

  cancel() {
    if (
      this.state === "idle" ||
      this.state === "done" ||
      this.state === "cancelled"
    ) {
      return;
    }

    if (this.rateLimitTimer !== null) {
      clearTimeout(this.rateLimitTimer);
      this.rateLimitTimer = null;
    }

    for (const controller of this.inflight.values()) {
      controller.abort();
    }
    this.inflight.clear();
    this.pending = [];

    this.setState("cancelled");
    this.emit("done", {
      completed: this.completed,
      failed: this.failed,
      cancelled: true,
    });
  }

  /**
   * Re-enqueue previously failed files.
   */
  retryFailed() {
    if (this.state !== "done" && this.state !== "cancelled") {
      return;
    }
    const filesToRetry = this.failed.map((f) => f.file);
    this.failed = [];
    this.pending = filesToRetry;
    this.total = filesToRetry.length;
    this.completed = [];

    this.setState("running");
    this.emitProgress();
    this.pump();
  }

  private emitProgress() {
    this.emit("progress", this.getProgress());
  }

  /**
   * Fill available concurrency slots from the pending queue.
   */
  private pump() {
    if (this.state !== "running" || this.pending.length === 0) {
      if (
        this.state === "running" &&
        this.inflight.size === 0 &&
        this.retrying === 0
      ) {
        this.setState("done");
        this.emit("done", {
          completed: this.completed,
          failed: this.failed,
          cancelled: false,
        });
      }
      return;
    }

    while (this.inflight.size < this.concurrency && this.pending.length > 0) {
      const file = this.pending.shift();
      if (file) {
        this.processFile(file).catch(() => {
          // Errors are handled inside processFile
        });
      }
    }
  }

  private async processFile(file: File, attempt = 0) {
    const controller = new AbortController();
    this.inflight.set(file, controller);

    try {
      const result = await this.uploadFn(file, controller.signal);
      this.inflight.delete(file);

      if (this.state === "cancelled") {
        return;
      }

      this.completed.push(result);
      this.emitProgress();
      this.pump();
    } catch (error) {
      this.inflight.delete(file);

      if (this.state === "cancelled") {
        return;
      }

      if (controller.signal.aborted) {
        return;
      }

      const status = getErrorStatus(error);

      if (status === HTTP_TOO_MANY_REQUESTS) {
        // Put the file back at the front of the queue
        this.pending.unshift(file);
        this.handleRateLimit(error);
        return;
      }

      // Retry on server errors and network failures
      // (status 0 = no HTTP response, e.g. DNS/connection)
      const isRetryable = status >= HTTP_SERVER_ERROR_MIN || status === 0;
      if (isRetryable && attempt < MAX_RETRIES) {
        const delay = RETRY_BACKOFF_MS[attempt] ?? 4000;
        this.retrying++;

        // Fill the freed concurrency slot while this file
        // waits for its backoff delay. Must come after
        // retrying++ so pump() doesn't see an empty queue
        // and emit "done" prematurely.
        this.pump();

        await sleep(delay);
        this.retrying--;

        // State may have changed during sleep (cancel,
        // pause). Only continue if still running.
        if (this.getState() !== "running") {
          // If cancelled, don't push back to pending
          // (already cleared by cancel()).
          if (this.getState() !== "cancelled") {
            this.pending.unshift(file);
          }
          return;
        }

        this.processFile(file, attempt + 1).catch(() => {
          // Errors are handled inside processFile
        });
        return;
      }

      // 4xx (not 429) or exhausted retries: permanent failure
      this.failed.push({
        file,
        error: transformUnknownError(error),
      });
      this.emitProgress();
      this.pump();
    }
  }

  private handleRateLimit(error: unknown) {
    // Don't override a user-initiated pause: in-flight
    // requests may return 429 after the user hit pause.
    if (this.state === "paused" || this.state === "cancelled") {
      return;
    }

    const retryAfterS = getRetryAfterSeconds(error) ?? DEFAULT_RETRY_AFTER_S;

    // Clear any existing timer to prevent orphaned timers
    // when multiple concurrent requests hit 429.
    if (this.rateLimitTimer !== null) {
      clearTimeout(this.rateLimitTimer);
    }

    // Only emit state change on first 429 in a burst;
    // subsequent concurrent 429s just reset the timer
    // but re-emit if the delay changed.
    if (this.state !== "rate-limited") {
      this.setState("rate-limited");
    }
    this.emit("rate-limited", { retryAfterS });

    this.rateLimitTimer = setTimeout(() => {
      this.rateLimitTimer = null;
      if (this.state === "rate-limited") {
        this.resume();
      }
    }, retryAfterS * 1000);
  }
}

// -- Error inspection helpers --

/**
 * Extract HTTP status from an error. Works with APIError
 * (which has a `status` field) and plain Error objects.
 */
const getErrorStatus = (error: unknown): number => {
  if (
    error !== null &&
    typeof error === "object" &&
    "status" in error &&
    typeof error.status === "number"
  ) {
    return error.status;
  }
  return 0;
};

/**
 * Extract `Retry-After` header value from an error that
 * carries a `headers` property (e.g., Eden treaty error
 * responses include a `response: Response` field).
 */
const getRetryAfterSeconds = (error: unknown): number | null => {
  if (
    error !== null &&
    typeof error === "object" &&
    "response" in error &&
    error.response instanceof Response
  ) {
    const header = error.response.headers.get("Retry-After");
    if (header) {
      const seconds = Number(header);
      if (Number.isFinite(seconds) && seconds > 0) {
        return seconds;
      }
    }
  }
  return null;
};
