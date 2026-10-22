import type { SanctionsSource } from "@stll/sanctions";

import { logger } from "@/api/lib/observability/logger";

/** A broken matcher must not keep an otherwise useful API instance out forever. */
export const SANCTIONS_STARTUP_WARMUP_BOUND_MS = 10 * 60 * 1000;
const SANCTIONS_STARTUP_POLL_MS = 1000;

export type SanctionsStartupWarmupStatus =
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
  }[]
>;

export const createSanctionsStartupWarmup = ({
  screen,
  now = () => performance.now(),
  sleep = Bun.sleep,
  boundMs = SANCTIONS_STARTUP_WARMUP_BOUND_MS,
}: {
  screen: StartupScreen;
  now?: () => number;
  sleep?: (durationMs: number) => Promise<unknown>;
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
      for (;;) {
        const lists = await screen();
        const warming = lists.filter(({ reason }) => reason === "warming");
        if (warming.length === 0) {
          state = {
            status: "terminal",
            reason: "settled",
            lists: new Map(
              lists.map(({ source, reason }) => [
                source,
                reason === "load-failed" ? "load-failed" : "warm",
              ]),
            ),
          };
          return;
        }
        if (now() - startedAt >= boundMs) {
          state = {
            status: "terminal",
            reason: "warming-bound-exceeded",
            lists: new Map(
              lists.map(({ source, reason }) => [
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
