/**
 * Periodic check that the database still accepts a new login.
 *
 * Pooled connections authenticate once, when they open, so neither the pools
 * nor the readiness probe exercise a login again while they stay warm. This
 * opens one new connection with the pools' URL on an interval, runs
 * `SELECT 1`, and closes it. It only reports through its failure sink: it
 * never changes readiness and never ends the process.
 */

import { Result, TaggedError } from "better-result";
import { SQL } from "bun";

import { declareFailureClass } from "@stll/errors";

import { startNonOverlappingInterval } from "@/api/lib/non-overlapping-interval";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";

export const DATABASE_LOGIN_PROBE_INTERVAL_MS = 5 * 60_000;
/** Budget for one attempt: connect, authenticate, query. */
export const DATABASE_LOGIN_ATTEMPT_DEADLINE_MS = 10_000;
const CONNECTION_TIMEOUT_S = 5;
// Seconds. On the pinned Bun, `close({ timeout: 0 })` waits for queries in
// flight like a close without a timeout, so a stalled query needs a positive
// bound to be ended.
const CLOSE_TIMEOUT_S = 0.001;

const FRESH_LOGIN_SINK = failureSink({ event: "db.fresh_login", expected: [] });

/** The database did not answer one attempt within its budget. */
class FreshLoginDeadlineError extends TaggedError("FreshLoginDeadlineError")<{
  message: string;
}> {
  static {
    declareFailureClass(this, "network_timeout");
  }
}

export type FreshLoginClient = {
  readonly selectOne: () => Promise<unknown>;
  /** Closes at once, ending a query still in flight. */
  readonly close: () => Promise<void>;
};

/** A dedicated one-connection client; nothing else shares its connection. */
export const openFreshLoginClient = (url: string): FreshLoginClient => {
  const client = new SQL({
    url,
    max: 1,
    connectionTimeout: CONNECTION_TIMEOUT_S,
  });
  return {
    selectOne: async () => {
      await client`SELECT 1`;
    },
    close: async () => {
      await client.close({ timeout: CLOSE_TIMEOUT_S });
    },
  };
};

type AttemptOptions = {
  readonly openClient: () => FreshLoginClient;
  readonly signal: AbortSignal;
};

type AttemptOutcome =
  | { readonly kind: "succeeded" }
  | { readonly kind: "aborted" }
  | { readonly kind: "failed"; readonly error: unknown };

const settle = async (
  query: Promise<unknown>,
  signal: AbortSignal,
): Promise<AttemptOutcome> => {
  const stopped = Promise.withResolvers<AttemptOutcome>();
  const onAbort = () => {
    stopped.resolve({ kind: "aborted" });
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    stopped.resolve({
      kind: "failed",
      error: new FreshLoginDeadlineError({
        message: `Database login check did not finish within ${String(DATABASE_LOGIN_ATTEMPT_DEADLINE_MS)} ms`,
      }),
    });
  }, DATABASE_LOGIN_ATTEMPT_DEADLINE_MS);
  try {
    return await Promise.race([
      query.then(
        (): AttemptOutcome => ({ kind: "succeeded" }),
        (error: unknown): AttemptOutcome => ({ kind: "failed", error }),
      ),
      stopped.promise,
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
};

/**
 * One attempt on its own client, closed whatever the outcome. A failure goes
 * to the sink, which grades it; a failed close is reported only when the
 * attempt itself did not fail first. An attempt ended by `signal` reports
 * nothing.
 */
export const attemptFreshLogin = async ({
  openClient,
  signal,
}: AttemptOptions): Promise<void> => {
  if (signal.aborted) {
    return;
  }
  const opened = Result.try({ try: openClient, catch: (cause) => cause });
  if (Result.isError(opened)) {
    observeFailure(opened.error, { sink: FRESH_LOGIN_SINK });
    return;
  }
  const client = opened.value;
  const outcome = await settle(client.selectOne(), signal);
  const closed = await Result.tryPromise({
    try: async () => {
      await client.close();
    },
    catch: (cause) => cause,
  });
  if (outcome.kind === "aborted") {
    return;
  }
  if (outcome.kind === "failed") {
    observeFailure(outcome.error, { sink: FRESH_LOGIN_SINK });
  } else if (Result.isError(closed)) {
    observeFailure(closed.error, { sink: FRESH_LOGIN_SINK });
  }
};

type StartOptions = {
  readonly openClient: () => FreshLoginClient;
  /** Picks the first attempt's offset into the interval; `Math.random` by default. */
  readonly random?: () => number;
};

/**
 * Starts the periodic check and returns its close. The first attempt waits a
 * random part of one interval, so replicas started together spread out.
 * Attempts never overlap, and close ends the one in flight.
 */
export const startDatabaseLoginProbe = ({
  openClient,
  random = Math.random,
}: StartOptions): (() => Promise<void>) => {
  const controller = new AbortController();
  const stop = startNonOverlappingInterval({
    initialDelayMs: Math.floor(random() * DATABASE_LOGIN_PROBE_INTERVAL_MS),
    intervalMs: DATABASE_LOGIN_PROBE_INTERVAL_MS,
    onError: (error) => {
      observeFailure(error, { sink: FRESH_LOGIN_SINK });
    },
    run: async () => {
      await attemptFreshLogin({ openClient, signal: controller.signal });
    },
  });
  return async () => {
    controller.abort();
    await stop();
  };
};
