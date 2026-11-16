import { panic } from "better-result";

import {
  ONLINE_MIGRATIONS_LOCK_RETRY_MS,
  pendingOnlineUnitKey,
} from "./online-migrations";
import type { PendingOnlineUnitOutcome } from "./online-migrations";

/** How long to wait while a migrate run holds the online lock. */
export const PENDING_ONLINE_RETRY_MS = 1000;

/**
 * The pause after every unit: twice the interval a waiting migrate run polls
 * the online lock at, so its next try lands while the drain holds nothing.
 */
export const PENDING_ONLINE_YIELD_MS = 2 * ONLINE_MIGRATIONS_LOCK_RETRY_MS;

/**
 * How long a repair held at a durable checkpoint is set aside before it is
 * tried again; the units after it keep building meanwhile.
 */
export const PENDING_ONLINE_HELD_RETRY_MS = 60_000;

type PendingOnlineDrainOptions = {
  /** One runner call, passing over the units in `skip`. */
  runUnit: (skip: ReadonlySet<string>) => Promise<PendingOnlineUnitOutcome>;
  sleep: (milliseconds: number) => Promise<void>;
  emit: (outcome: PendingOnlineUnitOutcome) => void;
};

/**
 * Walks pending online units until none is left, and resolves with the
 * number of unit walks. It pauses after every unit so a deploy's migrate run
 * is never kept off the online lock, waits out a migrate run that holds it,
 * waits a deferred build's retry delay, and sets a held repair aside so the
 * units after it still build. Once only held repairs are left it waits and
 * tries them again; it ends when nothing is pending.
 */
export const drainPendingOnlineUnits = async ({
  runUnit,
  sleep,
  emit,
}: PendingOnlineDrainOptions): Promise<number> => {
  let units = 0;
  let held = new Set<string>();
  for (;;) {
    const outcome = await runUnit(held);
    emit(outcome);
    switch (outcome.type) {
      case "busy":
        await sleep(PENDING_ONLINE_RETRY_MS);
        break;
      case "idle":
        if (held.size === 0) {
          return units;
        }
        await sleep(PENDING_ONLINE_HELD_RETRY_MS);
        held = new Set();
        break;
      case "ran":
        units += 1;
        if (outcome.outcome.type === "held") {
          held.add(pendingOnlineUnitKey(outcome.step));
        }
        await sleep(
          outcome.outcome.type === "deferred"
            ? Math.max(outcome.outcome.retryAfterMs, PENDING_ONLINE_YIELD_MS)
            : PENDING_ONLINE_YIELD_MS,
        );
        break;
      default:
        outcome satisfies never;
        return panic("Unknown pending online unit outcome");
    }
  }
};
