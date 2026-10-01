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
  if (acquisition.isErr()) {expect(acquisition.error.cause).toBe(failure);}
  expect(priorityProbes).toBe(2);
  expect(workHeld).toBe(false);
  await slot.close();
  expect(workHeld).toBe(false);
  expect(intentHeld).toBe(false);
});
