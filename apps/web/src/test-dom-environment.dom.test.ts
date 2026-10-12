import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { expect, test } from "bun:test";

import { loadReactScheduler } from "@/lib/react-scheduler-drain";
import { unregisterDomEnvironment } from "@/test-dom-environment";

test("teardown runs queued React work while the DOM globals still exist, then removes them", async () => {
  GlobalRegistrator.register();
  const scheduler = loadReactScheduler();
  const seen: string[] = [];
  // A passive effect left behind by a commit outside act() that reads the DOM.
  scheduler.unstable_scheduleCallback(scheduler.unstable_NormalPriority, () => {
    seen.push(`${typeof window}:${typeof document}`);
  });

  await unregisterDomEnvironment();

  expect(seen).toEqual(["object:object"]);
  expect(typeof window).toBe("undefined");
  expect(typeof document).toBe("undefined");
});
