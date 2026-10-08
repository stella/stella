/**
 * Measures how long work keeps the event loop from serving anything else.
 *
 * A timer ticks every `intervalMs`; the time a tick arrives late is time the
 * loop was blocked by synchronous work (a parse, a hash pass, an index build)
 * or by microtask chains that never yield to timers and I/O. The longest such
 * span is what a concurrent request would have waited.
 *
 *   const probe = startEventLoopLagProbe();
 *   await work();
 *   expectEventLoopResponsive(await probe.stop(), { budgetMs: 100 });
 *
 * Start the probe right before the work and stop it right after, so set-up
 * outside the work (fixture generation, database seeding) is not measured.
 *
 * Work against the in-process PGlite test database: wrap the client with
 * {@link pgliteAsOutOfProcess} before handing it to drizzle. PGlite executes
 * SQL on this thread and resolves through microtasks only, which a real
 * database connection never does, so without the wrapper its query time would
 * be charged to the code under test.
 *
 * A late tick only counts as blocked for as long as this process was using
 * CPU in the meantime, so a loaded machine that deschedules the process does
 * not read as blocking. The numbers still depend on the machine; budgets
 * should sit well above a quiet machine's baseline (a few ms).
 */
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { expect } from "bun:test";

import { sleep } from "@stll/concurrency/sleep";

export type BlockedSpan = {
  /** When the blocked span began, in ms since the probe started. */
  startedAtMs: number;
  blockedMs: number;
};

export type EventLoopLagReport = {
  maxBlockedMs: number;
  /** The longest blocked spans, longest first (at most five). */
  longestSpans: readonly BlockedSpan[];
  durationMs: number;
};

export type EventLoopLagProbe = {
  /** Waits for one more tick, so a span that is still open is measured. */
  stop: () => Promise<EventLoopLagReport>;
};

const KEPT_SPANS = 5;

type Interval = { from: number; to: number };

/** Time spent standing in for out-of-process I/O; never counted as blocking. */
const outOfProcess: Interval[] = [];
let activeProbes = 0;

const outOfProcessWithin = (from: number, to: number): number =>
  outOfProcess.reduce(
    (total, interval) =>
      total +
      Math.max(0, Math.min(to, interval.to) - Math.max(from, interval.from)),
    0,
  );

/** CPU time this process has used, user and system, in ms. */
const cpuMs = (): number => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};

export const startEventLoopLagProbe = ({
  intervalMs = 5,
}: { intervalMs?: number } = {}): EventLoopLagProbe => {
  activeProbes += 1;
  const startedAt = performance.now();
  let previous = startedAt;
  let previousCpuMs = cpuMs();
  const spans: BlockedSpan[] = [];
  const record = (now: number) => {
    const cpuNowMs = cpuMs();
    const excludedMs = outOfProcessWithin(previous, now);
    const blockedMs = Math.min(
      now - previous - intervalMs - excludedMs,
      cpuNowMs - previousCpuMs - excludedMs,
    );
    previousCpuMs = cpuNowMs;
    if (blockedMs > 0) {
      spans.push({ startedAtMs: previous - startedAt, blockedMs });
      spans.sort((left, right) => right.blockedMs - left.blockedMs);
      spans.length = Math.min(spans.length, KEPT_SPANS);
    }
    previous = now;
  };
  const timer = setInterval(() => {
    record(performance.now());
  }, intervalMs);
  return {
    stop: async () => {
      await sleep(intervalMs);
      clearInterval(timer);
      record(performance.now());
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

const nextMacrotask = async () => {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
};

/** Starts counting time as out-of-process; null while no probe runs. */
const openOutOfProcess = (): Interval | null => {
  if (activeProbes === 0) {
    return null;
  }
  const interval = { from: performance.now(), to: Number.POSITIVE_INFINITY };
  outOfProcess.push(interval);
  return interval;
};

const closeOutOfProcess = (interval: Interval | null) => {
  if (interval !== null && interval.to === Number.POSITIVE_INFINITY) {
    interval.to = performance.now();
  }
};

/**
 * Runs `work` as a stand-in for a round trip to another process: it starts on
 * a fresh macrotask, as a network reply would arrive, and its own run time is
 * not counted against the code that awaits it.
 */
const asRoundTrip = async <T>(work: () => Promise<T>): Promise<T> => {
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
