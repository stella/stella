import { expect, mock, test } from "bun:test";

import { startConfiguredScheduler } from "@/api/server-scheduled-jobs";

test("disabled scheduled jobs neither register jobs nor start a loop", async () => {
  const ensureDefaultJobs = mock(async () => undefined);
  const startLoop = mock(() => ({
    runnerId: "test-runner",
    drained: Promise.resolve(),
    stop: () => undefined,
  }));
  const info = mock(() => undefined);

  const loop = await startConfiguredScheduler({
    mode: "disabled",
    ensureDefaultJobs,
    startLoop,
    logger: { info },
  });

  expect(loop).toBeUndefined();
  expect(ensureDefaultJobs).not.toHaveBeenCalled();
  expect(startLoop).not.toHaveBeenCalled();
  expect(info).not.toHaveBeenCalled();
});

test("enabled scheduled jobs await registration before starting and logging the loop once", async () => {
  const registration = Promise.withResolvers<undefined>();
  const calls: string[] = [];
  const ensureDefaultJobs = mock(async () => {
    calls.push("register");
    await registration.promise;
  });
  const loop = {
    runnerId: "test-runner",
    drained: Promise.resolve(),
    stop: () => undefined,
  };
  const startLoop = mock(() => {
    calls.push("start");
    return loop;
  });
  const info = mock(() => {
    calls.push("log");
  });

  const started = startConfiguredScheduler({
    mode: "enabled",
    ensureDefaultJobs,
    startLoop,
    logger: { info },
  });
  expect(calls).toEqual(["register"]);
  expect(startLoop).not.toHaveBeenCalled();

  registration.resolve(undefined);
  expect(await started).toBe(loop);
  expect(calls).toEqual(["register", "start", "log"]);
  expect(ensureDefaultJobs).toHaveBeenCalledTimes(1);
  expect(startLoop).toHaveBeenCalledTimes(1);
  expect(info).toHaveBeenCalledTimes(1);
  expect(info).toHaveBeenCalledWith("scheduler.started", {
    "scheduler.runner_id": loop.runnerId,
  });
});
