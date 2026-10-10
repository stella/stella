import { expect, test } from "bun:test";

import {
  drainReactScheduler,
  loadReactScheduler,
} from "@/lib/react-scheduler-drain";

test("the drain resolves only after queued React work and the work it enqueues", async () => {
  const scheduler = loadReactScheduler();
  const ran: string[] = [];
  // The shape of React's passive-effect flush after a commit outside act().
  scheduler.unstable_scheduleCallback(scheduler.unstable_NormalPriority, () => {
    ran.push("effects");
    scheduler.unstable_scheduleCallback(
      scheduler.unstable_NormalPriority,
      () => {
        ran.push("follow-up");
      },
    );
  });

  await drainReactScheduler();

  expect(ran).toEqual(["effects", "follow-up"]);
});
