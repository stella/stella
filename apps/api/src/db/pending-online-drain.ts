import { panic } from "better-result";

import type { PendingOnlineUnitOutcome } from "./online-migrations";

/** How long to wait for a migrate run, or before retrying a held unit. */
export const PENDING_ONLINE_RETRY_MS = 1000;

type PendingOnlineDrainOptions = {
  runUnit: () => Promise<PendingOnlineUnitOutcome>;
  sleep: (milliseconds: number) => Promise<void>;
  emit: (outcome: PendingOnlineUnitOutcome) => void;
  /** The unit the previous call walked; a repeat waits before it runs again. */
  previous?: string | undefined;
};

const unitKey = ({ kind, name }: { kind: string; name: string }) =>
  `${kind}:${name}`;

/**
 * Walks pending online units until none is left. It waits out a migrate run
 * that holds the online lock, a deferred build's retry delay, and, before a
 * unit runs again, the retry interval: a repair held at a durable checkpoint
 * reports the same unit until its health verdict clears. Resolves with the
 * number of unit walks.
 */
export const drainPendingOnlineUnits = async ({
  runUnit,
  sleep,
  emit,
  previous,
}: PendingOnlineDrainOptions): Promise<number> => {
  const outcome = await runUnit();
  emit(outcome);
  switch (outcome.type) {
    case "idle":
      return 0;
    case "busy":
      await sleep(PENDING_ONLINE_RETRY_MS);
      return await drainPendingOnlineUnits({ runUnit, sleep, emit, previous });
    case "ran": {
      const current = unitKey(outcome.step);
      if (outcome.outcome.type === "deferred") {
        await sleep(outcome.outcome.retryAfterMs);
      } else if (current === previous) {
        await sleep(PENDING_ONLINE_RETRY_MS);
      }
      return (
        1 +
        (await drainPendingOnlineUnits({
          runUnit,
          sleep,
          emit,
          previous: current,
        }))
      );
    }
    default:
      outcome satisfies never;
      return panic("Unknown pending online unit outcome");
  }
};
