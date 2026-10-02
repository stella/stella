import { TaggedError } from "better-result";
import { expect, test } from "bun:test";

import { createHeavyWorkSlot } from "./heavy-work-slot";

class PriorityProbeError extends TaggedError("PriorityProbeError")<{
  message: string;
}> {}

test("a failed priority probe releases work and closing releases intent without replacing the error", async () => {
  const failure = new PriorityProbeError({
    message: "injected priority probe failure",
  });
  let workHeld = false;
  let intentHeld = false;
  let priorityProbes = 0;
  const slot = createHeavyWorkSlot({
    kind: "backfill_batch",
    session: {
      query: async (statement) => {
        if (statement.includes("pg_try_advisory_lock_shared")) {
          intentHeld = true;
          return [{ acquired: true }];
        }
        if (statement.includes("pg_try_advisory_lock(")) {
          workHeld = true;
          return [{ acquired: true }];
        }
        if (statement.includes("pg_advisory_unlock_shared")) {
          const acquired = intentHeld;
          intentHeld = false;
          return [{ acquired }];
        }
        if (statement.includes("pg_advisory_unlock(")) {
          const acquired = workHeld;
          workHeld = false;
          return [{ acquired }];
        }
        priorityProbes += 1;
        if (priorityProbes === 2) {
          expect(workHeld).toBe(true);
          expect(intentHeld).toBe(true);
          throw failure;
        }
        return [{ acquired: true }];
      },
    },
  });

  const acquisition = await slot.tryAcquire();
  expect(acquisition.isErr()).toBe(true);
  if (acquisition.isErr()) {
    expect(acquisition.error.cause).toBe(failure);
  }
  expect(priorityProbes).toBe(2);
  expect(workHeld).toBe(false);
  await slot.close();
  expect(workHeld).toBe(false);
  expect(intentHeld).toBe(false);
});

// The last release before operator jobs used this key; keep the rollout contract pinned.
const OLD_BACKFILL_INTENT_KEY = 3;

test("backfill keeps the deployed intent key while operator intent includes an old-reader alias", async () => {
  for (const [kind, expectedKeys] of [
    ["backfill_batch", [OLD_BACKFILL_INTENT_KEY]],
    ["operator_job", [4, 2]],
  ] as const) {
    const registrations: number[] = [];
    const releases: number[] = [];
    const slot = createHeavyWorkSlot({
      kind,
      session: {
        query: async (statement, parameters) => {
          const key = parameters.at(1);
          if (key === undefined) {
            throw new TypeError("missing advisory key");
          }
          if (statement.includes("pg_try_advisory_lock_shared")) {
            registrations.push(key);
          }
          if (statement.includes("pg_advisory_unlock_shared")) {
            releases.push(key);
          }
          return [{ acquired: true }];
        },
      },
    });
    expect((await slot.tryAcquire()).unwrap()).toBe(true);
    expect((await slot.tryAcquire()).unwrap()).toBe(true);
    expect(registrations).toEqual([...expectedKeys]);
    await slot.close();
    await slot.close();
    expect(releases).toEqual(expectedKeys.toReversed());
  }
});
