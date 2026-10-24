import { Result } from "better-result";

import type { SanctionsSource } from "@stll/sanctions";

import { failureSink } from "@/api/lib/observability/failure";
import { logger } from "@/api/lib/observability/logger";
import { observeFailure } from "@/api/lib/observability/observe-failure";

/** A broken matcher must not keep an otherwise useful API instance out forever. */
const SANCTIONS_STARTUP_WARMUP_BOUND_MS = 10 * 60 * 1000;
const SANCTIONS_STARTUP_POLL_MS = 1000;
const STARTUP_SCREEN_FAILED_SINK = failureSink({
  event: "sanctions.startup_warmup_screen_failed",
  expected: [],
});

type SanctionsStartupWarmupStatus =
  | { status: "warming" }
  | {
      status: "terminal";
      lists: ReadonlyMap<SanctionsSource, "warm" | "load-failed">;
      reason: "settled" | "warming-bound-exceeded";
    };

type StartupScreen = () => Promise<
  readonly {
    source: SanctionsSource;
    reason: string | null;
    loaderState: "warming" | "retrying" | "terminal" | null;
  }[]
>;

export const createSanctionsStartupWarmup = ({
  screen,
  now = () => performance.now(),
  sleep = Bun.sleep,
  terminalize,
  boundMs = SANCTIONS_STARTUP_WARMUP_BOUND_MS,
}: {
  screen: StartupScreen;
  now?: () => number;
  sleep?: (durationMs: number) => Promise<unknown>;
  terminalize: () => void;
  boundMs?: number;
}) => {
  let state: SanctionsStartupWarmupStatus = { status: "warming" };
  let running: Promise<void> | null = null;

  const start = (): void => {
    if (running !== null || state.status === "terminal") {
      return;
    }
    const startedAt = now();
    running = (async () => {
      let lastLists: Awaited<ReturnType<StartupScreen>> = [];
      for (;;) {
        const screened = await Result.tryPromise({
          try: screen,
          catch: (cause) => cause,
        });
        if (Result.isOk(screened)) {
          lastLists = screened.value;
        } else {
          observeFailure(screened.error, { sink: STARTUP_SCREEN_FAILED_SINK });
        }
        const warming = lastLists.filter(
          ({ reason, loaderState }) =>
            reason === "warming" || loaderState === "retrying",
        );
        if (Result.isOk(screened) && warming.length === 0) {
          state = {
            status: "terminal",
            reason: "settled",
            lists: new Map(
              lastLists.map(({ source, reason, loaderState }) => [
                source,
                loaderState === "terminal" && reason === "load-failed"
                  ? "load-failed"
                  : "warm",
              ]),
            ),
          };
          return;
        }
        if (now() - startedAt >= boundMs) {
          terminalize();
          state = {
            status: "terminal",
            reason: "warming-bound-exceeded",
            lists: new Map(
              lastLists.map(({ source, reason }) => [
                source,
                reason === "warming" || reason === "load-failed"
                  ? "load-failed"
                  : "warm",
              ]),
            ),
          };
          logger.error("sanctions.startup_warmup_bound_exceeded", {
            sources: warming.map(({ source }) => source).join(","),
            boundMs,
          });
          return;
        }
        await sleep(SANCTIONS_STARTUP_POLL_MS);
      }
    })();
  };

  return { start, status: () => state, settled: async () => await running };
};
