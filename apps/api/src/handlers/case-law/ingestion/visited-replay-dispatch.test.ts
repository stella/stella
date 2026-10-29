import { expect, test } from "bun:test";

import { createSafeId } from "@/api/lib/branded-types";

import {
  VISITED_REPLAY_DROP_REASON,
  type VisitedReplayCandidate,
  type VisitedReplayDropReason,
} from "./visited-replay";
import { createVisitedReplayDispatch } from "./visited-replay-dispatch";

const candidate = {
  sourceId: createSafeId<"caseLawSource">(),
  decisionId: createSafeId<"caseLawDecision">(),
} satisfies VisitedReplayCandidate;

const fixture = () => {
  const scheduled: (() => void)[] = [];
  const tracked: Promise<void>[] = [];
  const drops: VisitedReplayDropReason[] = [];
  let finishFlush = () => {};
  let flushes = 0;
  let admission: ReturnType<
    Parameters<typeof createVisitedReplayDispatch>[0]["signals"]["offer"]
  > = "buffered";
  const dispatch = createVisitedReplayDispatch({
    signals: { offer: () => admission },
    flush: () => {
      flushes += 1;
      return new Promise<void>((resolve) => {
        finishFlush = resolve;
      });
    },
    track: (work) => {
      tracked.push(work);
    },
    schedule: (work) => {
      scheduled.push(work);
    },
    now: () => 0,
    recordDrop: (reason) => {
      drops.push(reason);
    },
  });
  return {
    dispatch,
    scheduled,
    tracked,
    drops,
    admission: (value: typeof admission) => {
      admission = value;
    },
    flushes: () => flushes,
    finish: () => finishFlush(),
  };
};

test("read events coalesce without awaiting queue persistence or polling", async () => {
  const f = fixture();
  expect(f.dispatch.offer(candidate)).toBe("buffered");
  f.dispatch.offer(candidate);
  expect(f.scheduled).toHaveLength(1);
  expect(f.flushes()).toBe(0);
  f.scheduled.shift()?.();
  await Promise.resolve();
  expect(f.flushes()).toBe(1);
  f.dispatch.offer(candidate);
  f.dispatch.offer(candidate);
  expect(f.scheduled).toHaveLength(0);
  f.finish();
  await Promise.all(f.tracked);
  expect(f.scheduled).toHaveLength(1);
  f.scheduled.shift()?.();
  await Promise.resolve();
  f.finish();
  await Promise.all(f.tracked);
  expect(f.flushes()).toBe(2);
  expect(f.scheduled).toHaveLength(0);
});

test("every drop-new ceiling counts without waiting for persistence", () => {
  const f = fixture();
  for (const reason of Object.values(VISITED_REPLAY_DROP_REASON)) {
    f.admission(reason);
    expect(f.dispatch.offer(candidate)).toBe(reason);
  }
  expect(f.drops).toEqual(Object.values(VISITED_REPLAY_DROP_REASON));
  expect(f.scheduled).toHaveLength(1);
  expect(f.tracked).toHaveLength(0);
  expect(f.flushes()).toBe(0);
  f.admission("external-corpus");
  f.dispatch.offer(candidate);
  expect(f.drops).toHaveLength(3);
});
