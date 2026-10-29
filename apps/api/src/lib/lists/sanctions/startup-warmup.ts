import { Result } from "better-result";

import type { SanctionsSource } from "@stll/sanctions";

import { SANCTIONS_STARTUP_WARMUP_BUDGET_MS } from "@/api/lib/health/startup-contract";
import { failureSink } from "@/api/lib/observability/failure";
import { logger } from "@/api/lib/observability/logger";
import { observeFailure } from "@/api/lib/observability/observe-failure";

/** A broken matcher must not keep an otherwise useful API instance out forever. */
const SANCTIONS_STARTUP_POLL_MS = 1000;
const STARTUP_SCREEN_FAILED_SINK = failureSink({
  event: "sanctions.startup_warmup_screen_failed",
  expected: [],
});

type SanctionsStartupWarmupStatus =
  | { status: "warming" }
  | {
      status: "terminal";
      lists: ReadonlyMap<SanctionsSource, "warm" | "unavailable">;
      reason: "settled" | "warming-bound-exceeded";
    };

type StartupList = {
  source: SanctionsSource;
  reason: string | null;
  loaderState: "warming" | "retrying" | "terminal" | null;
};

type StartupScreen = () => Promise<Result<readonly StartupList[], unknown>>;

/** A list screens once its reason clears; any other reason leaves it unavailable. */
const listOutcomes = (lists: readonly StartupList[]) =>
  new Map<SanctionsSource, "warm" | "unavailable">(
    lists.map(({ source, reason }) => [
      source,
      reason === null ? "warm" : "unavailable",
    ]),
  );

export const createSanctionsStartupWarmup = ({
  screen,
  now = () => performance.now(),
  sleep = Bun.sleep,
  terminalize,
  boundMs = SANCTIONS_STARTUP_WARMUP_BUDGET_MS,
  observe = (observation) => {
    logger.info("sanctions.startup_warmup", observation);
  },
}: {
  screen: StartupScreen;
  now?: () => number;
  sleep?: (durationMs: number) => Promise<unknown>;
  terminalize: () => void;
  boundMs?: number;
  observe?: (observation: {
    totalMs: number;
    editions: Readonly<Record<string, number>>;
    reason: "settled" | "warming-bound-exceeded";
  }) => void;
}) => {
  let state: SanctionsStartupWarmupStatus = { status: "warming" };
  let running: Promise<void> | null = null;

  const start = (): void => {
    if (running !== null || state.status === "terminal") {
      return;
    }
    const startedAt = now();
    running = (async () => {
      let lastLists: readonly StartupList[] = [];
      const editionStartedAt = new Map<SanctionsSource, number>();
      const editionDurations = new Map<SanctionsSource, number>();
      const finish = (reason: "settled" | "warming-bound-exceeded") => {
        const finishedAt = now();
        for (const { source } of lastLists) {
          const sourceStartedAt = editionStartedAt.get(source) ?? startedAt;
          if (!editionDurations.has(source)) {
            editionDurations.set(
              source,
              Math.round(finishedAt - sourceStartedAt),
            );
          }
        }
        observe({
          totalMs: Math.round(finishedAt - startedAt),
          editions: Object.fromEntries(editionDurations),
          reason,
        });
      };
      for (;;) {
        // A failed screening and a rejected one are both retried.
        const screened = (
          await Result.tryPromise({ try: screen, catch: (cause) => cause })
        ).andThen((outcome) => outcome);
        if (Result.isOk(screened)) {
          lastLists = screened.value;
          const instant = now();
          for (const { source, reason, loaderState } of lastLists) {
            editionStartedAt.set(
              source,
              editionStartedAt.get(source) ?? startedAt,
            );
            if (
              reason !== "warming" &&
              loaderState !== "warming" &&
              loaderState !== "retrying" &&
              !editionDurations.has(source)
            ) {
              editionDurations.set(
                source,
                Math.round(
                  instant - (editionStartedAt.get(source) ?? startedAt),
                ),
              );
            }
          }
        } else {
          observeFailure(screened.error, { sink: STARTUP_SCREEN_FAILED_SINK });
        }
        // A list is still settling while its loader warms or waits to retry,
        // whatever reason the screening that raced it reported.
        const warming = lastLists.filter(
          ({ reason, loaderState }) =>
            reason === "warming" ||
            loaderState === "warming" ||
            loaderState === "retrying",
        );
        if (Result.isOk(screened) && warming.length === 0) {
          state = {
            status: "terminal",
            reason: "settled",
            lists: listOutcomes(lastLists),
          };
          finish("settled");
          return;
        }
        if (now() - startedAt >= boundMs) {
          terminalize();
          state = {
            status: "terminal",
            reason: "warming-bound-exceeded",
            lists: listOutcomes(lastLists),
          };
          logger.error("sanctions.startup_warmup_bound_exceeded", {
            sources: warming.map(({ source }) => source).join(","),
            boundMs,
          });
          finish("warming-bound-exceeded");
          return;
        }
        await sleep(SANCTIONS_STARTUP_POLL_MS);
      }
    })();
  };

  return { start, status: () => state, settled: async () => await running };
};
