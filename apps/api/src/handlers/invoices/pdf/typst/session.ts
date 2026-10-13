import { Worker } from "node:worker_threads";

import type { TypstOutputFormat } from "./compiler";
import type { TypstWorkerReply, TypstWorkerRequest } from "./protocol";

const MIB = 1024 * 1024;

/**
 * Bounds for one render. A user-edited template is untrusted code: the
 * compiler has no file system or network, and these limits bound the time,
 * memory and output it can spend.
 */
export type TypstRenderLimits = {
  /** Wall clock for one compile; the worker is terminated when it runs over. */
  timeoutMs: number;
  /** Process RSS growth over the pre-render baseline that terminates the worker. */
  maxMemoryGrowthBytes: number;
  maxOutputBytes: number;
  maxTemplateBytes: number;
  maxInputBytes: number;
  /**
   * WASM linear memory never shrinks, so a worker that grew past this after
   * a successful render is replaced before the next one.
   */
  retireAboveMemoryBytes: number;
};

export const TYPST_RENDER_LIMITS = {
  timeoutMs: 10_000,
  maxMemoryGrowthBytes: 512 * MIB,
  maxOutputBytes: 20 * MIB,
  maxTemplateBytes: 256 * 1024,
  maxInputBytes: 2 * MIB,
  retireAboveMemoryBytes: 256 * MIB,
} as const satisfies TypstRenderLimits;

const MEMORY_SAMPLE_MS = 10;
const WORKER_START_TIMEOUT_MS = 10_000;

type TypstRenderRejection =
  | "template-too-large"
  | "input-too-large"
  | "diagnostics"
  | "output-too-large"
  | "timeout"
  | "memory"
  | "crashed";

export type TypstRenderOutcome =
  | {
      status: "rendered";
      bytes: Uint8Array;
      compileMs: number;
      memoryBytes: number;
    }
  | {
      status: "rejected";
      reason: TypstRenderRejection;
      diagnostics: string[];
    };

export type TypstRenderRequest = {
  template: string;
  inputs: Record<string, string>;
  format: TypstOutputFormat;
};

export type TypstSession = {
  render: (request: TypstRenderRequest) => Promise<TypstRenderOutcome>;
  close: () => Promise<void>;
};

type LiveWorker = { worker: Worker; ready: Promise<boolean> };

const startWorker = (): LiveWorker => {
  const worker = new Worker(new URL("worker.ts", import.meta.url));
  const ready = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), WORKER_START_TIMEOUT_MS);
    worker.once("message", (reply: TypstWorkerReply) => {
      clearTimeout(timer);
      resolve(reply.type === "ready");
    });
    worker.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
  return { worker, ready };
};

const byteLength = (value: string) => Buffer.byteLength(value, "utf-8");

/**
 * One render worker reused across renders (warm), replaced after any limit
 * breach, crash or excessive memory growth. Renders run one at a time.
 */
export const openTypstSession = (
  limits: TypstRenderLimits = TYPST_RENDER_LIMITS,
): TypstSession => {
  let live: LiveWorker | null = null;
  let nextId = 0;
  let queue: Promise<unknown> = Promise.resolve();

  const retire = async () => {
    const current = live;
    live = null;
    if (current !== null) {
      await current.worker.terminate();
    }
  };

  const run = async (
    request: TypstRenderRequest,
  ): Promise<TypstRenderOutcome> => {
    if (byteLength(request.template) > limits.maxTemplateBytes) {
      return {
        status: "rejected",
        reason: "template-too-large",
        diagnostics: [
          `Template exceeds ${String(limits.maxTemplateBytes)} bytes`,
        ],
      };
    }
    const inputBytes = Object.entries(request.inputs).reduce(
      (total, [key, value]) => total + byteLength(key) + byteLength(value),
      0,
    );
    if (inputBytes > limits.maxInputBytes) {
      return {
        status: "rejected",
        reason: "input-too-large",
        diagnostics: [`Inputs exceed ${String(limits.maxInputBytes)} bytes`],
      };
    }
    live ??= startWorker();
    const current = live;
    if (!(await current.ready)) {
      await retire();
      return {
        status: "rejected",
        reason: "crashed",
        diagnostics: ["The Typst worker did not start"],
      };
    }
    nextId += 1;
    const id = nextId;
    const baseline = process.memoryUsage.rss();
    const outcome = await new Promise<
      TypstRenderOutcome & { memoryBytes?: number }
    >((resolve) => {
      const cleanup: (() => void)[] = [];
      const finish = (value: TypstRenderOutcome & { memoryBytes?: number }) => {
        for (const undo of cleanup) {
          undo();
        }
        resolve(value);
      };
      const timer = setTimeout(() => {
        finish({
          status: "rejected",
          reason: "timeout",
          diagnostics: [`Render exceeded ${String(limits.timeoutMs)} ms`],
        });
      }, limits.timeoutMs);
      cleanup.push(() => clearTimeout(timer));
      const sampler = setInterval(() => {
        const growth = process.memoryUsage.rss() - baseline;
        if (growth > limits.maxMemoryGrowthBytes) {
          finish({
            status: "rejected",
            reason: "memory",
            diagnostics: [
              `Render grew memory by ${String(growth)} bytes; the limit is ${String(limits.maxMemoryGrowthBytes)}`,
            ],
          });
        }
      }, MEMORY_SAMPLE_MS);
      cleanup.push(() => clearInterval(sampler));
      const onMessage = (reply: TypstWorkerReply) => {
        if (reply.type === "rendered" && reply.id === id) {
          finish({
            status: "rendered",
            bytes: reply.bytes,
            compileMs: reply.compileMs,
            memoryBytes: reply.memoryBytes,
          });
        } else if (reply.type === "failed" && reply.id === id) {
          finish({
            status: "rejected",
            reason: reply.reason,
            diagnostics: reply.diagnostics,
            memoryBytes: reply.memoryBytes,
          });
        }
      };
      const onError = (error: unknown) => {
        finish({
          status: "rejected",
          reason: "crashed",
          diagnostics: [String(error)],
        });
      };
      const onExit = (code: number) => {
        finish({
          status: "rejected",
          reason: "crashed",
          diagnostics: [`The Typst worker exited with code ${String(code)}`],
        });
      };
      current.worker.on("message", onMessage);
      current.worker.on("error", onError);
      current.worker.on("exit", onExit);
      cleanup.push(() => {
        current.worker.off("message", onMessage);
        current.worker.off("error", onError);
        current.worker.off("exit", onExit);
      });
      current.worker.postMessage(
        {
          id,
          ...request,
          maxOutputBytes: limits.maxOutputBytes,
        } satisfies TypstWorkerRequest,
        [],
      );
    });
    const keep =
      (outcome.status === "rendered" ||
        outcome.reason === "diagnostics" ||
        outcome.reason === "output-too-large") &&
      (outcome.memoryBytes ?? 0) <= limits.retireAboveMemoryBytes;
    if (!keep) {
      await retire();
    }
    return outcome;
  };

  return {
    render: (request) => {
      const next = queue.then(() => run(request));
      // Keep the queue alive whatever this render's outcome; the caller
      // receives the rejection through `next`.
      queue = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
    close: async () => {
      await queue;
      await retire();
    },
  };
};
