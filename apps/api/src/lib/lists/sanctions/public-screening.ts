import { panic, Result } from "better-result";

import { createDetached } from "@stll/errors";
import { DEFAULT_CUTOFF } from "@stll/sanctions";
import type { SanctionsSource } from "@stll/sanctions";

import { logger } from "@/api/lib/observability/logger";

import {
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
 * How long one edition's load may run before it counts as stalled. Far above
 * a real load, so it never cuts one short; it only frees a hung worker.
 */
export const SANCTIONS_WARM_STALL_MS = 10 * 60 * 1000;

/** Backoff between attempts to load an edition that failed to load. */
export const SANCTIONS_WARM_RETRY_MS = {
  initial: 5000,
  max: 5 * 60 * 1000,
} as const;

type PublicScreeningOptions = {
  pool?: typeof sharedSanctionsMatcherPool;
  loadEntries?: typeof loadEditionEntries;
  reportFailure?: typeof reportSanctionsScreeningFailure;
  now?: () => number;
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

/**
 * Loads editions into the matcher in one background lease per edition, apart
 * from request deadlines: a slow edition finishes, and each loaded one stays
 * loaded while another fails.
 */
const createEditionWarmer = ({
  pool,
  loadEntries,
  reportFailure,
  now,
}: Required<PublicScreeningOptions>) => {
  const targets = new Map<SanctionsSource, WarmTarget>();
  const state: { db: SanctionsReadDb | null; running: Promise<void> | null } = {
    db: null,
    running: null,
  };
  const detached = createDetached((error) => {
    reportFailure({ stage: "public-warmup", reason: "operation", error });
  });

  const warm = async (
    db: SanctionsReadDb,
    source: SanctionsSource,
    { edition }: WarmTarget,
  ): Promise<MatcherWorkOutcome<Result<void, WarmFailure>>> =>
    await pool.run(
      async (session): Promise<Result<void, WarmFailure>> => {
        if (session.hasEdition(source, edition.id)) {
          return Result.ok(undefined);
        }
        const startedAt = now();
        const loaded = await Result.tryPromise(
          async () =>
            await loadEntries({ db, edition, signal: session.signal }),
        );
        if (loaded.isErr()) {
          return Result.err({ reason: "entries-read", cause: loaded.error });
        }
        if (loaded.value.length !== edition.entryCount) {
          return Result.err({ reason: "short-read" });
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
    isRunning: () => state.running !== null,
    /** Every pass started so far, including any that start as one ends. */
    settled: async () => {
      while (state.running !== null) {
        // db-await-in-loop: drains a bounded chain of warmup passes in tests
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
  now = () => performance.now(),
}: PublicScreeningOptions = {}) => {
  const warmer = createEditionWarmer({
    pool,
    loadEntries,
    reportFailure,
    now,
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
    // The warmup holds the matcher: answer from what is on file meanwhile
    // instead of queueing behind it.
    if (warmer.isRunning()) {
      return await screenSanctionsSubject({
        ...props,
        reportFailure,
        matcher: async (list) => notLoaded(list),
      });
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
