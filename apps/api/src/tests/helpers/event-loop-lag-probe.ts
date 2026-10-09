/**
 * Measures event-loop-thread CPU time between macrotask turns, including
 * microtask chains. Descheduling, I/O waits, and background threads consume
 * no CPU on this thread, so shared-runner load cannot inflate the measurement.
 *
 * Start immediately before the work and stop immediately after it. Wrap the
 * PGlite client with {@link pgliteAsOutOfProcess} to exclude its query CPU.
 */
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { expect } from "bun:test";

import { nextMacrotask } from "@stll/concurrency/event-loop";

type BlockedSpan = {
  /** When the blocked span began, in ms since the probe started. */
  startedAtMs: number;
  /** Event-loop-thread CPU in this slice, with PGlite CPU excluded. */
  blockedMs: number;
};

export type EventLoopLagReport = {
  /** Longest CPU slice; independent of wall-clock scheduling delays. */
  maxBlockedMs: number;
  /** The longest blocked spans, longest first (at most five). */
  longestSpans: readonly BlockedSpan[];
  durationMs: number;
};

export type EventLoopLagProbe = {
  /** Waits for one more macrotask, so the final slice is measured. */
  stop: () => Promise<EventLoopLagReport>;
};

const KEPT_SPANS = 5;

type Interval = { from: number; to: number };

/** Time spent standing in for out-of-process I/O; never counted as blocking. */
const outOfProcess: Interval[] = [];
let activeProbes = 0;

// CPU-coordinate intervals are unioned: nested/overlapping queries must not
// subtract the same CPU twice. Wall time must never erase later synchronous CPU.
const outOfProcessWithin = (from: number, to: number): number => {
  let cursor = from;
  let excluded = 0;
  for (const interval of outOfProcess) {
    const end = Math.min(to, interval.to);
    excluded += Math.max(0, end - Math.max(cursor, interval.from));
    cursor = Math.max(cursor, end);
  }
  return excluded;
};

/** CPU time the event-loop thread has used, user and system, in ms. */
const cpuMs = (): number => {
  const { user, system } = process.threadCpuUsage();
  return (user + system) / 1000;
};

export const startEventLoopLagProbe = (): EventLoopLagProbe => {
  activeProbes += 1;
  const startedAt = performance.now();
  let previous = startedAt;
  let previousCpuMs = cpuMs();
  const spans: BlockedSpan[] = [];
  const record = () => {
    const now = performance.now();
    const cpuNowMs = cpuMs();
    const blockedMs =
      cpuNowMs - previousCpuMs - outOfProcessWithin(previousCpuMs, cpuNowMs);
    previousCpuMs = cpuNowMs;
    if (blockedMs > 0) {
      spans.push({ startedAtMs: previous - startedAt, blockedMs });
      spans.sort((left, right) => right.blockedMs - left.blockedMs);
      spans.length = Math.min(spans.length, KEPT_SPANS);
    }
    previous = now;
  };
  // Sample each macrotask rather than a timer interval that can combine many
  // yielded slices. Do not cap CPU by wall lateness: that can hide blocking.
  const sample = () => {
    record();
    pendingSample = setImmediate(sample);
  };
  let pendingSample = setImmediate(sample);
  return {
    stop: async () => {
      clearImmediate(pendingSample);
      await nextMacrotask();
      record();
      activeProbes -= 1;
      if (activeProbes === 0) {
        outOfProcess.length = 0;
      }
      return {
        maxBlockedMs: spans.at(0)?.blockedMs ?? 0,
        longestSpans: [...spans],
        durationMs: performance.now() - startedAt,
      };
    },
  };
};

/** Starts counting time as out-of-process; null while no probe runs. */
const openOutOfProcess = (): Interval | null => {
  if (activeProbes === 0) {
    return null;
  }
  const interval = { from: cpuMs(), to: Number.POSITIVE_INFINITY };
  outOfProcess.push(interval);
  return interval;
};

const closeOutOfProcess = (interval: Interval | null) => {
  if (interval !== null && interval.to === Number.POSITIVE_INFINITY) {
    interval.to = cpuMs();
  }
};

/**
 * Runs `work` as a stand-in for a round trip to another process: it starts on
 * a fresh macrotask, as a network reply would arrive, and its own run time is
 * not counted against the code that awaits it.
 */
export const asRoundTrip = async <T>(work: () => Promise<T>): Promise<T> => {
  await nextMacrotask();
  const interval = openOutOfProcess();
  try {
    return await work();
  } finally {
    closeOutOfProcess(interval);
  }
};

const roundTripQueries = <T extends PGlite | Transaction>(client: T): T =>
  new Proxy(client, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (
        (property === "query" || property === "exec") &&
        typeof value === "function"
      ) {
        return async (...args: unknown[]) =>
          await asRoundTrip(
            async (): Promise<unknown> =>
              await Reflect.apply(value, target, args),
          );
      }
      if (typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]): unknown =>
        Reflect.apply(value, target, args);
    },
  });

/**
 * A PGlite client whose statements behave like a database in another
 * process: each one yields to the event loop first, and the time PGlite
 * spends executing it on this thread is not counted by a running probe. Code
 * between statements, including inside a transaction callback, still is.
 */
export const pgliteAsOutOfProcess = (client: PGlite): PGlite =>
  new Proxy(roundTripQueries(client), {
    get(target, property, receiver) {
      if (property !== "transaction") {
        const value: unknown = Reflect.get(target, property, receiver);
        return value;
      }
      return async <T>(
        callback: (tx: Transaction) => Promise<T>,
      ): Promise<T> => {
        // BEGIN and COMMIT run inside PGlite around the callback; only the
        // callback itself is measured.
        await nextMacrotask();
        const begin = openOutOfProcess();
        let finish: Interval | null = null;
        try {
          return await client.transaction(async (tx) => {
            closeOutOfProcess(begin);
            try {
              return await callback(roundTripQueries(tx));
            } finally {
              finish = openOutOfProcess();
            }
          });
        } finally {
          closeOutOfProcess(begin);
          closeOutOfProcess(finish);
        }
      };
    },
  });

/** Fails when any span of the measured work blocked the loop past `budgetMs`. */
export const expectEventLoopResponsive = (
  report: EventLoopLagReport,
  { budgetMs }: { budgetMs: number },
): void => {
  const spans = report.longestSpans
    .map(
      ({ startedAtMs, blockedMs }) =>
        `${Math.round(blockedMs)} ms at +${Math.round(startedAtMs)} ms`,
    )
    .join(", ");
  expect(
    report.maxBlockedMs,
    `the event loop was blocked for longer than ${budgetMs} ms (${spans})`,
  ).toBeLessThanOrEqual(budgetMs);
};
