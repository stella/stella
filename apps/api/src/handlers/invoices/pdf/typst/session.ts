import { Result } from "better-result";
import type { Subprocess } from "bun";
import { fileURLToPath } from "node:url";

import type { TypstOutputFormat } from "./compiler";
import { TYPST_MEMORY_SIGNAL } from "./protocol";
import type { TypstWorkerReply, TypstWorkerRequest } from "./protocol";

const MIB = 1024 * 1024;

/**
 * Bounds for one render. A user-edited template is untrusted code: the
 * compiler has no file system or network, and these limits bound the time,
 * memory and output it can spend.
 */
export type TypstRenderLimits = {
  /** Wall clock for one compile; the renderer process is killed when it runs over. */
  timeoutMs: number;
  /** RSS growth of the renderer process over its idle size that kills it. */
  maxMemoryGrowthBytes: number;
  maxOutputBytes: number;
  maxTemplateBytes: number;
  maxInputBytes: number;
  /**
   * WASM linear memory never shrinks, so a renderer that grew past this after
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

const START_TIMEOUT_MS = 30_000;

export type TypstSessionOptions = {
  /**
   * An idle renderer process exits after this long, so a server that renders
   * an invoice only at issue time holds no renderer between issues.
   */
  idleExitMs: number;
};

export const TYPST_SESSION_OPTIONS = {
  idleExitMs: 60_000,
} as const satisfies TypstSessionOptions;

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
      peakRssBytes: number;
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
  /** Renderer processes started and exited so far; equal when none runs. */
  renderers: () => { started: number; exited: number; pid: number | null };
};

type Renderer = {
  process: Subprocess;
  ready: Promise<boolean>;
  /** Receives the renderer's replies after it reported ready. */
  listen: (listener: ((reply: TypstWorkerReply) => void) | null) => void;
  /** Resolves after the process exited and every exit callback ran. */
  gone: Promise<void>;
  /** True once the process exited, whether or not a render was running. */
  isGone: () => boolean;
  /** Called once if the process exits while a render waits on it. */
  watchExit: (listener: (() => void) | null) => void;
};

const RENDERER_PATH = fileURLToPath(new URL("worker.ts", import.meta.url));

const isReply = (value: unknown): value is TypstWorkerReply =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  (value.type === "ready" ||
    value.type === "rendered" ||
    value.type === "failed");

const startRenderer = (
  limits: TypstRenderLimits,
  onExit: () => void,
): Renderer => {
  let listener: ((reply: TypstWorkerReply) => void) | null = null;
  let exitListener: (() => void) | null = null;
  let resolveReady: (ready: boolean) => void = () => undefined;
  const ready = new Promise<boolean>((resolve) => {
    resolveReady = resolve;
  });
  const timer = setTimeout(() => {
    resolveReady(false);
  }, START_TIMEOUT_MS);
  let exited = false;
  let markGone: () => void = () => undefined;
  const gone = new Promise<void>((resolve) => {
    markGone = resolve;
  });
  const markReady = (value: boolean) => {
    clearTimeout(timer);
    resolveReady(value);
  };
  const child = Bun.spawn({
    cmd: [process.execPath, RENDERER_PATH, String(limits.maxMemoryGrowthBytes)],
    stdin: "ignore",
    stdout: "ignore",
    // Typst's in-memory file model logs refused reads; diagnostics reach the
    // caller through IPC instead.
    stderr: "ignore",
    ipc: (message: unknown) => {
      if (!isReply(message)) {
        return;
      }
      if (message.type === "ready") {
        markReady(true);
        return;
      }
      listener?.(message);
    },
    onExit: () => {
      exited = true;
      markReady(false);
      onExit();
      exitListener?.();
      markGone();
    },
  });
  return {
    process: child,
    ready,
    gone,
    isGone: () => exited,
    listen: (next) => {
      listener = next;
    },
    watchExit: (next) => {
      exitListener = next;
    },
  };
};

const byteLength = (value: string) => Buffer.byteLength(value, "utf-8");

/**
 * One renderer process reused across renders (warm), replaced after any limit
 * breach, crash or excessive memory growth. Renders run one at a time.
 */
export const openTypstSession = (
  limits: TypstRenderLimits = TYPST_RENDER_LIMITS,
  options: TypstSessionOptions = TYPST_SESSION_OPTIONS,
): TypstSession => {
  let live: Renderer | null = null;
  let idleTimer: Timer | undefined;
  let nextId = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const counts = { started: 0, exited: 0 };

  const retire = async () => {
    const current = live;
    live = null;
    if (current !== null) {
      current.process.kill("SIGKILL");
      // Resolves once the process is gone, so a killed render has stopped
      // running before the caller sees its outcome.
      await current.gone;
    }
  };

  /** The live renderer, replacing one that exited since its last render. */
  const acquire = async () => {
    if (live?.isGone() === true) {
      live = null;
    }
    if (live === null) {
      counts.started += 1;
      live = startRenderer(limits, () => {
        counts.exited += 1;
      });
    }
    const current = live;
    return (await current.ready) ? current : null;
  };

  const attempt = async (
    request: TypstRenderRequest,
  ): Promise<(TypstRenderOutcome & { memoryBytes?: number }) | "unsent"> => {
    const current = await acquire();
    if (current === null) {
      await retire();
      return {
        status: "rejected",
        reason: "crashed",
        diagnostics: ["The Typst renderer did not start"],
      };
    }
    nextId += 1;
    const id = nextId;
    return await new Promise((resolve) => {
      const state: { settled: boolean; timer?: Timer } = { settled: false };
      const finish = (
        value: (TypstRenderOutcome & { memoryBytes?: number }) | "unsent",
      ) => {
        if (state.settled) {
          return;
        }
        state.settled = true;
        clearTimeout(state.timer);
        current.listen(null);
        current.watchExit(null);
        resolve(value);
      };
      state.timer = setTimeout(() => {
        finish({
          status: "rejected",
          reason: "timeout",
          diagnostics: [`Render exceeded ${String(limits.timeoutMs)} ms`],
        });
      }, limits.timeoutMs);
      current.listen((reply) => {
        if (reply.type === "rendered" && reply.id === id) {
          finish({
            status: "rendered",
            bytes: reply.bytes,
            compileMs: reply.compileMs,
            memoryBytes: reply.memoryBytes,
            peakRssBytes: reply.peakRssBytes,
          });
        } else if (reply.type === "failed" && reply.id === id) {
          finish({
            status: "rejected",
            reason: reply.reason,
            diagnostics: reply.diagnostics,
            memoryBytes: reply.memoryBytes,
          });
        }
      });
      current.watchExit(() => {
        const memory = current.process.signalCode === TYPST_MEMORY_SIGNAL;
        finish({
          status: "rejected",
          reason: memory ? "memory" : "crashed",
          diagnostics: [
            memory
              ? `Render grew memory past ${String(limits.maxMemoryGrowthBytes)} bytes`
              : `The Typst renderer exited (${String(current.process.signalCode ?? current.process.exitCode)})`,
          ],
        });
      });
      if (current.isGone()) {
        // Exited between acquiring it and sending: its exit callback already
        // ran, so nothing else would settle this render.
        finish("unsent");
        return;
      }
      const sent = Result.try(() => {
        current.process.send({
          id,
          ...request,
          maxOutputBytes: limits.maxOutputBytes,
        } satisfies TypstWorkerRequest);
      });
      if (sent.isErr()) {
        finish("unsent");
      }
    });
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
    let outcome = await attempt(request);
    if (outcome === "unsent") {
      // The IPC channel closed before the request reached the renderer, so
      // nothing of it ran: one retry on a fresh process is safe. A renderer
      // that exits after receiving a request is reported as "crashed" and is
      // not retried, because the template itself may be what crashed it.
      await retire();
      outcome = await attempt(request);
    }
    if (outcome === "unsent") {
      await retire();
      return {
        status: "rejected",
        reason: "crashed",
        diagnostics: ["The Typst renderer could not receive the request"],
      };
    }
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

  const scheduleIdleExit = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      queue = queue.then(async () => retire());
    }, options.idleExitMs);
    idleTimer.unref();
  };

  return {
    render: async (request) => {
      clearTimeout(idleTimer);
      const next = queue.then(async () => {
        const outcome = await run(request);
        scheduleIdleExit();
        return outcome;
      });
      // Keep the queue alive whatever this render's outcome; the caller
      // receives the rejection through `next`.
      queue = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
    close: async () => {
      clearTimeout(idleTimer);
      await queue;
      await retire();
    },
    renderers: () => ({ ...counts, pid: live?.process.pid ?? null }),
  };
};
