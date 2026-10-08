import { panic, Result } from "better-result";

import { createDetached } from "@stll/errors";
import { DEFAULT_CUTOFF } from "@stll/sanctions";
import type { SanctionsEntry, SanctionsSource } from "@stll/sanctions";

import { logger } from "@/api/lib/observability/logger";

import {
  SANCTIONS_MATCHER_CONFIG,
  sharedSanctionsMatcherPool,
  isSanctionsMatcherCancelled,
} from "./matcher-pool";
import type { MatcherWorkOutcome } from "./matcher-pool";
import type { SanctionsReadDb } from "./read-db";
import { reportSanctionsScreeningFailure } from "./screening-failure";
import type { SanctionsScreeningFailureCause } from "./screening-failure";
import { loadEditionEntries } from "./screening-index";
import type { SanctionsActiveEdition } from "./screening-index";
import {
  screenSanctionsSubject,
  unavailableSanctionsScreening,
} from "./screening-service";

/** How long a caller waits before asking again while lists load. */
export const SANCTIONS_WARMING_RETRY_AFTER_SECONDS = 5;

/**
 * How long indexing one edition may hold the matcher before it counts as
 * stalled. Far above a real index build, so it never cuts one short; it only
 * frees a hung worker. The database read runs outside it.
 */
export const SANCTIONS_WARM_STALL_MS = 2 * 60 * 1000;

/** Backoff between attempts to load an edition that failed to load. */
export const SANCTIONS_WARM_RETRY_MS = {
  initial: 5000,
  max: 5 * 60 * 1000,
} as const;

/**
 * How long one edition's database read may run before it counts as stalled:
 * its read is cancelled and the warmup moves on to the next edition.
 */
export const SANCTIONS_WARM_READ_STALL_MS = 5 * 60 * 1000;

type WarmClock = {
  now: () => number;
  schedule: (expire: () => void, durationMs: number) => () => void;
};

const warmClock = {
  now: () => performance.now(),
  schedule: (expire, durationMs) => {
    const timer = setTimeout(expire, durationMs);
    return () => {
      clearTimeout(timer);
    };
  },
} satisfies WarmClock;

type PublicScreeningOptions = {
  pool?: typeof sharedSanctionsMatcherPool;
  loadEntries?: typeof loadEditionEntries;
  reportFailure?: typeof reportSanctionsScreeningFailure;
  clock?: WarmClock;
};

type WarmTarget = {
  edition: SanctionsActiveEdition;
  failures: number;
  retryAt: number;
};

type WarmFailure = {
  reason: SanctionsScreeningFailureCause;
  cause?: unknown;
};

const warmFailure = (
  outcome: MatcherWorkOutcome<Result<void, WarmFailure>>,
): WarmFailure | null => {
  if (outcome.status === "unavailable") {
    return { reason: outcome.cause, cause: outcome.error };
  }
  return outcome.value.isErr() ? outcome.value.error : null;
};

type EditionRead = {
  editionId: string;
  controller: AbortController;
  settled: Promise<Result<SanctionsEntry[], unknown>>;
};

/**
 * At most one database read per list, even one the warmup stopped waiting
 * for: a retry waits on it again rather than starting a second.
 */
const createEditionReads = ({
  loadEntries,
  clock,
}: Pick<Required<PublicScreeningOptions>, "loadEntries" | "clock">) => {
  const reads = new Map<SanctionsSource, EditionRead>();

  const startRead = (
    db: SanctionsReadDb,
    source: SanctionsSource,
    edition: SanctionsActiveEdition,
  ): EditionRead => {
    const controller = new AbortController();
    const read: EditionRead = {
      editionId: edition.id,
      controller,
      settled: Result.tryPromise(
        async () =>
          await loadEntries({ db, edition, signal: controller.signal }),
      ),
    };
    reads.set(source, read);
    return read;
  };

  /**
   * One stall window: the read's result, or "stalled" when it outlasts it. A
   * read that lands after its window is kept until a later attempt takes it.
   */
  const awaitRead = async (source: SanctionsSource, read: EditionRead) => {
    const stalled = Promise.withResolvers<"stalled">();
    const cancelStall = clock.schedule(() => {
      read.controller.abort();
      stalled.resolve("stalled");
    }, SANCTIONS_WARM_READ_STALL_MS);
    const outcome = await Promise.race([read.settled, stalled.promise]).finally(
      cancelStall,
    );
    if (outcome !== "stalled" && reads.get(source) === read) {
      reads.delete(source);
    }
    return outcome;
  };

  return async (
    db: SanctionsReadDb,
    source: SanctionsSource,
    edition: SanctionsActiveEdition,
  ) => {
    const previous = reads.get(source);
    // An older edition's read still runs: it must settle before another starts.
    if (
      previous !== undefined &&
      previous.editionId !== edition.id &&
      (await awaitRead(source, previous)) === "stalled"
    ) {
      return "stalled";
    }
    const current = reads.get(source);
    return await awaitRead(
      source,
      current?.editionId === edition.id
        ? current
        : startRead(db, source, edition),
    );
  };
};

/**
 * Loads editions into the matcher one at a time in the background, apart from
 * request deadlines: a slow edition finishes, and each loaded one stays loaded
 * and keeps screening while another loads or fails.
 */
const createEditionWarmer = ({
  pool,
  loadEntries,
  reportFailure,
  clock,
}: Required<PublicScreeningOptions>) => {
  const { now } = clock;
  const targets = new Map<SanctionsSource, WarmTarget>();
  const state: {
    db: SanctionsReadDb | null;
    running: Promise<void> | null;
    holdsMatcher: boolean;
  } = { db: null, running: null, holdsMatcher: false };
  const detached = createDetached((error) => {
    reportFailure({ stage: "public-warmup", reason: "operation", error });
  });
  const readEdition = createEditionReads({ loadEntries, clock });

  // The read runs outside any lease: loaded lists keep screening meanwhile.
  // Only the transfer and index hold the matcher.
  const warm = async (
    db: SanctionsReadDb,
    source: SanctionsSource,
    { edition }: WarmTarget,
  ): Promise<MatcherWorkOutcome<Result<void, WarmFailure>>> => {
    const startedAt = now();
    const loaded = await readEdition(db, source, edition);
    if (loaded === "stalled") {
      return {
        status: "completed",
        value: Result.err({ reason: "read-stalled" }),
      };
    }
    if (loaded.isErr()) {
      return {
        status: "completed",
        value: Result.err({ reason: "entries-read", cause: loaded.error }),
      };
    }
    if (loaded.value.length !== edition.entryCount) {
      return {
        status: "completed",
        value: Result.err({ reason: "short-read" }),
      };
    }
    state.holdsMatcher = true;
    try {
      return await pool.run(
        async (session): Promise<Result<void, WarmFailure>> => {
          if (session.hasEdition(source, edition.id)) {
            return Result.ok(undefined);
          }
          const indexed = await session.load({
            source,
            editionId: edition.id,
            list: {
              version: {
                source,
                publishedAt: edition.publishedAt,
                fileId: edition.fileId,
              },
              entries: loaded.value,
            },
          });
          if (indexed !== "indexed") {
            return Result.err({ reason: "matcher-unavailable" });
          }
          logger.info("sanctions.edition_warmed", {
            source,
            entries: edition.entryCount,
            durationMs: Math.round(now() - startedAt),
          });
          return Result.ok(undefined);
        },
        { deadlineMs: SANCTIONS_WARM_STALL_MS },
      );
    } finally {
      state.holdsMatcher = false;
    }
  };

  const settle = (
    source: SanctionsSource,
    target: WarmTarget,
    outcome: MatcherWorkOutcome<Result<void, WarmFailure>>,
  ) => {
    // A newer edition replaced this one while it loaded; the next pass loads it.
    if (targets.get(source) !== target) {
      return;
    }
    const failure = warmFailure(outcome);
    if (failure === null) {
      targets.delete(source);
      return;
    }
    target.failures += 1;
    target.retryAt =
      now() +
      Math.min(
        SANCTIONS_WARM_RETRY_MS.initial * 2 ** (target.failures - 1),
        SANCTIONS_WARM_RETRY_MS.max,
      );
    // Reported here, once per attempt, rather than by every request that
    // meets the list while it waits out the backoff.
    reportFailure({
      stage: "public-warmup",
      reason: failure.reason,
      source,
      error: failure.cause,
    });
  };

  const pass = async () => {
    for (;;) {
      const instant = now();
      const due = [...targets].find(([, target]) => target.retryAt <= instant);
      if (due === undefined || state.db === null) {
        return;
      }
      const [source, target] = due;
      // db-await-in-loop: one edition at a time keeps a single bounded load in memory
      settle(source, target, await warm(state.db, source, target));
    }
  };

  const start = () => {
    const running = pass().finally(() => {
      state.running = null;
    });
    state.running = running;
    detached(running, "sanctions.public-warmup");
  };

  return {
    /** The warmup is indexing an edition; the matcher answers nothing else. */
    holdsMatcher: () => state.holdsMatcher,
    /** Like `want`, without asking for the edition: a request that cannot check it. */
    status: (
      source: SanctionsSource,
      edition: SanctionsActiveEdition,
    ): "warming" | "load-failed" => {
      const target = targets.get(source);
      return target?.edition.id === edition.id && target.retryAt > now()
        ? "load-failed"
        : "warming";
    },
    /** Every pass started so far, including any that start as one ends. */
    settled: async () => {
      while (state.running !== null) {
        await state.running;
      }
    },
    /**
     * Ask for an edition that is not loaded. Answers whether it is loading or
     * waiting out a failed attempt.
     */
    want: (
      db: SanctionsReadDb,
      source: SanctionsSource,
      edition: SanctionsActiveEdition,
    ): "warming" | "load-failed" => {
      state.db = db;
      const instant = now();
      let target = targets.get(source);
      if (target?.edition.id !== edition.id) {
        target = { edition, failures: 0, retryAt: instant };
        targets.set(source, target);
      }
      if (target.retryAt > instant) {
        return "load-failed";
      }
      if (state.running === null) {
        start();
      }
      return "warming";
    },
  };
};

export const createPublicSanctionsScreening = ({
  pool = sharedSanctionsMatcherPool,
  loadEntries = loadEditionEntries,
  reportFailure = reportSanctionsScreeningFailure,
  clock = warmClock,
}: PublicScreeningOptions = {}) => {
  // Indexes live per worker and the warmup loads into the one it leases, so
  // only a single worker is guaranteed to hold what was warmed.
  if (pool.size !== 1) {
    panic("Public sanctions screening warms a single matcher worker");
  }
  const warmer = createEditionWarmer({
    pool,
    loadEntries,
    reportFailure,
    clock,
  });
  const notLoaded = ({
    db,
    source,
    edition,
  }: {
    db: SanctionsReadDb;
    source: SanctionsSource;
    edition: SanctionsActiveEdition;
  }) =>
    Result.err({
      code: warmer.want(db, source, edition),
      stage: "public-warmup",
      reason: null,
    } as const);

  const screenPublic: typeof screenSanctionsSubject = async (props) => {
    // The warmup is indexing for a moment: answer from what is on file
    // instead of queueing behind it, and ask again shortly.
    if (warmer.holdsMatcher()) {
      // Bounded like a matcher lease: the freshness read alone must not hold
      // the request past its deadline.
      const expired = Promise.withResolvers<"expired">();
      const cancelDeadline = clock.schedule(() => {
        expired.resolve("expired");
      }, SANCTIONS_MATCHER_CONFIG.deadlineMs);
      const answered = await Promise.race([
        screenSanctionsSubject({
          ...props,
          reportFailure,
          matcher: async ({ source, edition }) =>
            Result.err({
              code: warmer.status(source, edition),
              stage: "public-warmup",
              reason: null,
            } as const),
        }),
        expired.promise,
      ]).finally(cancelDeadline);
      return answered === "expired"
        ? Result.ok(
            unavailableSanctionsScreening({
              reason: "warming",
              practiceJurisdictions: props.practiceJurisdictions,
              now: props.now,
            }),
          )
        : answered;
    }
    const result = await pool.run(
      async (session) =>
        await screenSanctionsSubject({
          ...props,
          reportFailure: (failure) => {
            if (!isSanctionsMatcherCancelled(session.signal)) {
              reportFailure(failure);
            }
          },
          matcher: async ({ db, source, edition, query, limit }) => {
            if (isSanctionsMatcherCancelled(session.signal)) {
              return Result.err({
                code: "load-failed",
                stage: "list-screening",
                reason: "matcher-unavailable",
              } as const);
            }
            if (!session.hasEdition(source, edition.id)) {
              return notLoaded({ db, source, edition });
            }
            const reply = await session.match({
              source,
              editionId: edition.id,
              list: null,
              query,
              cutoff: DEFAULT_CUTOFF,
              limit,
            });
            switch (reply.status) {
              case "screened":
                return Result.ok(reply.result);
              case "work-limit":
                return Result.err({
                  code: "load-failed",
                  stage: "public-matcher",
                  reason: "work-limit",
                } as const);
              case "unavailable":
              case "entries-loaded":
              case "indexed":
                return Result.err({
                  code: "load-failed",
                  stage: "public-matcher",
                  reason: "matcher-unavailable",
                } as const);
              default:
                reply satisfies never;
                return panic("Unhandled sanctions matcher reply");
            }
          },
        }),
    );
    if (result.status === "completed") {
      return result.value;
    }
    reportFailure({
      stage: "whole-screening",
      reason: result.cause,
      error: result.error,
    });
    return Result.ok(
      unavailableSanctionsScreening({
        reason: "load-failed",
        practiceJurisdictions: props.practiceJurisdictions,
        now: props.now,
      }),
    );
  };
  return Object.assign(screenPublic, { warmupSettled: warmer.settled });
};

export const screenPublicSanctionsSubject = createPublicSanctionsScreening();
