import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { expect, test } from "bun:test";

import {
  loadReactScheduler,
  unregisterDomEnvironment,
} from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/" });

test("scheduled React work runs before the DOM globals are removed", async () => {
  const scheduler = loadReactScheduler();
  const seen: boolean[] = [];
  // The shape of React's passive-effect flush after a commit outside act().
  scheduler.unstable_scheduleCallback(scheduler.unstable_NormalPriority, () => {
    seen.push(typeof window !== "undefined");
  });

  await unregisterDomEnvironment();

  expect(seen).toEqual([true]);
});
