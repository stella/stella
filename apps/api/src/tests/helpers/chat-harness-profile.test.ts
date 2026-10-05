import { expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  currentQueryCount,
  runWithQueryCounter,
} from "@/api/lib/db-query-counter";

import { createChatHarnessProfile } from "./chat-harness-profile";

const deferred = () => {
  let complete = () => {};
  const promise = new Promise<void>((resolve) => {
    complete = resolve;
  });
  return { promise, resolve: complete };
};

test("nested same-phase operations share one span and stay within wall time", async () => {
  for (const phase of ["action", "oracle"] as const) {
    let time = 0;
    const profile = createChatHarnessProfile("same-phase.test.ts", {
      now: () => time,
    });
    const result = await profile.measure(phase, async () => {
      time = 2;
      const value = await profile.measure(phase, async () => {
        time = 4;
        return await profile.measure(phase, async () => {
          profile.logger.logQuery("select 1", []);
          time = 6;
          return 42;
        });
      });
      time = 10;
      return value;
    });
    expect(result).toBe(42);
    const summary = profile.summary();
    const total = summary.phases.find((entry) => entry.phase === phase);
    expect(total).toMatchObject({
      calls: 1,
      inclusiveMs: 10,
      selfMs: 10,
      statements: 1,
    });
    expect(total?.inclusiveMs).toBeLessThanOrEqual(summary.elapsedMs);
  }
});

test("nested SQL belongs once to its closest phase while the shared counter remains accurate", async () => {
  const profile = createChatHarnessProfile("nested.test.ts");
  await runWithQueryCounter(async () => {
    await profile.measure("action", async () => {
      profile.logger.logQuery(" SELECT secret FROM private", [
        "private parameter",
      ]);
      await profile.measure("oracle", async () => {
        profile.logger.logQuery("insert into private values (?)", [
          "private parameter",
        ]);
        profile.logger.logQuery("UPDATE private set value = ?", []);
        profile.logger.logQuery("delete from private", []);
        profile.logger.logQuery("BEGIN", []);
      });
    });
    expect(currentQueryCount()).toBe(5);
  });
  const summary = profile.summary();
  expect(summary.statements).toBe(5);
  expect(
    summary.phases.find(({ phase }) => phase === "action")?.statements,
  ).toBe(1);
  expect(summary.phases.find(({ phase }) => phase === "oracle")?.kinds).toEqual(
    { read: 0, write: 3, other: 1 },
  );
  expect(summary.phases.reduce((sum, phase) => sum + phase.statements, 0)).toBe(
    5,
  );
  expect(JSON.stringify(summary)).not.toContain("private");
  const snapshot = profile.summary();
  const action = snapshot.phases.find(({ phase }) => phase === "action");
  if (action !== undefined) {
    action.kinds.read = 999;
  }
  expect(
    profile.summary().phases.find(({ phase }) => phase === "action")?.kinds
      .read,
  ).toBe(1);
});

test("concurrent child durations subtract their busy union rather than their summed durations", async () => {
  let time = 0;
  const profile = createChatHarnessProfile("concurrent.test.ts", {
    now: () => time,
  });
  const first = deferred();
  const second = deferred();
  await profile.measure("action", async () => {
    time = 2;
    const childOne = profile.measure("oracle", async () => {
      await first.promise;
      profile.logger.logQuery("select 1", []);
    });
    time = 4;
    const childTwo = profile.measure("replay", async () => {
      await second.promise;
      profile.logger.logQuery("insert into t values (1)", []);
    });
    time = 8;
    first.resolve();
    await childOne;
    time = 10;
    second.resolve();
    await childTwo;
    time = 12;
    profile.logger.logQuery("select 2", []);
  });
  const summary = profile.summary();
  expect(summary.elapsedMs).toBe(12);
  expect(summary.phases.find(({ phase }) => phase === "action")).toMatchObject({
    calls: 1,
    inclusiveMs: 12,
    selfMs: 4,
    statements: 1,
  });
  expect(summary.phases.find(({ phase }) => phase === "oracle")).toMatchObject({
    inclusiveMs: 6,
    selfMs: 6,
    statements: 1,
  });
  expect(summary.phases.find(({ phase }) => phase === "replay")).toMatchObject({
    inclusiveMs: 6,
    selfMs: 6,
    statements: 1,
  });
});

test("rejected nested spans account their time and rethrow the original failure", async () => {
  let time = 0;
  const profile = createChatHarnessProfile("failure.test.ts", {
    now: () => time,
  });
  const failure = new TypeError("fixture rejected");
  expect(
    await rejectionOf(
      profile.measure("fixture", async () => {
        time = 2;
        await profile.measure("prepare", async () => {
          time = 5;
          throw failure;
        });
      }),
    ),
  ).toBe(failure);
  expect(
    profile.summary().phases.find(({ phase }) => phase === "fixture"),
  ).toMatchObject({ calls: 1, inclusiveMs: 5, selfMs: 2 });
  expect(
    profile.summary().phases.find(({ phase }) => phase === "prepare"),
  ).toMatchObject({ calls: 1, inclusiveMs: 3, selfMs: 3 });
  time = 7;
  await profile.measure("fixture", async () => {
    time = 9;
  });
  expect(
    profile.summary().phases.find(({ phase }) => phase === "fixture"),
  ).toMatchObject({ calls: 2, inclusiveMs: 7, selfMs: 4 });
});

test("late child continuations bill the closest ancestor that is still active", async () => {
  const profile = createChatHarnessProfile("late.test.ts");
  const release = deferred();
  let continuation = Promise.resolve();
  await profile.measure("action", async () => {
    await profile.measure("oracle", async () => {
      continuation = release.promise.then(() => {
        profile.logger.logQuery("select 1", []);
        return undefined;
      });
    });
    release.resolve();
    await continuation;
  });
  profile.logger.logQuery("select outside", []);
  const summary = profile.summary();
  expect(
    summary.phases.find(({ phase }) => phase === "oracle")?.statements,
  ).toBe(0);
  expect(
    summary.phases.find(({ phase }) => phase === "action")?.statements,
  ).toBe(1);
  expect(
    summary.phases.find(({ phase }) => phase === "unattributed")?.statements,
  ).toBe(1);
  expect(summary.statements).toBe(2);
});

test("detached queries after all spans finish remain in the unattributed census", async () => {
  const profile = createChatHarnessProfile("detached.test.ts");
  const release = deferred();
  let continuation = Promise.resolve();
  await profile.measure("webSettlement", async () => {
    continuation = release.promise.then(() => {
      profile.logger.logQuery("select detached", []);
      return undefined;
    });
  });
  release.resolve();
  await continuation;
  expect(profile.summary().statements).toBe(1);
  expect(
    profile.summary().phases.find(({ phase }) => phase === "unattributed")
      ?.kinds.read,
  ).toBe(1);
  expect(
    profile.summary().phases.find(({ phase }) => phase === "webSettlement")
      ?.statements,
  ).toBe(0);
});
