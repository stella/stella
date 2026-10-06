import { expect, test } from "bun:test";

import { allApiTests } from "./api-test-impact";
import { parseApiTestImpact, planCiApiTests } from "./ci-api-test-plan";

const selected = () => ({
  mode: "selected" as const,
  files: ["src/a.test.ts", "src/b.test.ts"],
  shards: 2,
});

test("pull requests omit idle API runners and keep the shared rest/web runner", () => {
  const plan = planCiApiTests({
    event: "pull_request",
    scopeUnknown: false,
    apiInScope: false,
    select: () => {
      throw new Error("selector should not run");
    },
  });
  expect(plan.matrix).toEqual({ shard: ["rest-web"] });
  expect(plan.impact.mode).toBe("none");
  expect(
    planCiApiTests({
      event: "pull_request",
      scopeUnknown: false,
      apiInScope: true,
      select: () => ({ mode: "none", files: [], shards: 0 }),
    }).matrix,
  ).toEqual({ shard: ["rest-web"] });
  expect(
    planCiApiTests({
      event: "pull_request",
      scopeUnknown: false,
      apiInScope: true,
      select: selected,
    }).matrix,
  ).toEqual({ shard: ["api-1", "api-2", "rest-web"] });
});

test("merge groups, dispatches and unreadable scopes retain four shards without invoking the selector", () => {
  for (const [event, scopeUnknown] of [
    ["merge_group", false],
    ["workflow_dispatch", false],
    ["pull_request", true],
  ] as const) {
    const plan = planCiApiTests({
      event,
      scopeUnknown,
      apiInScope: false,
      select: () => {
        throw new Error("selector should not run");
      },
    });
    expect(plan.impact).toEqual(allApiTests());
    expect(plan.matrix.shard).toEqual([
      "api-1",
      "api-2",
      "api-3",
      "api-4",
      "rest-web",
    ]);
  }
});

test("crashes and malformed selector output cannot remove API work", () => {
  expect(
    planCiApiTests({
      event: "pull_request",
      scopeUnknown: false,
      apiInScope: true,
      select: () => {
        throw new Error("planted crash");
      },
    }).impact,
  ).toEqual(allApiTests());
  for (const output of [
    "bad JSON",
    "{}",
    '{"mode":"none","files":[],"shards":4}',
    '{"mode":"selected","files":[],"shards":0}',
    JSON.stringify({ ...selected(), shards: 4 }),
    JSON.stringify({
      ...selected(),
      files: ["src/a.test.ts", "src/a.test.ts"],
    }),
    JSON.stringify({
      ...selected(),
      files: ["src/../../outside.test.ts", "src/a.test.ts"],
    }),
  ]) {
    expect(parseApiTestImpact(output)).toEqual(allApiTests());
  }
  expect(parseApiTestImpact(JSON.stringify(selected()))).toEqual(selected());
});
