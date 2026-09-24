import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

// `member-call` rows are scoped by path, which the passive fixture under
// `.oxlint-plugins/__fixtures__` cannot sit inside, so they are exercised here
// with a source written beneath the scoped prefix.
const MEMBER_CALL_OPTIONS = {
  entries: [
    {
      id: "deterministic-job-requeue",
      owner: ["apps/api/src/lib/bullmq-requeue.ts"],
      enforcement: {
        kind: "member-call",
        method: "getState",
        within: ["apps/api/src/"],
        allowed: [{ path: "apps/api/src/lib/allowed.ts", reason: "test" }],
      },
    },
  ],
};

const SOURCE = [
  "const state = await job.getState();",
  "const optional = await job?.getState();",
  "const other = await job.getStatus();",
  "const read = job.getState;",
  "",
].join("\n");

const lint = async (sourcePath: string) =>
  await lintSingleRule("confine-owner", SOURCE, {
    ruleOptions: MEMBER_CALL_OPTIONS,
    sourcePath,
  });

describe.serial("confine-owner member-call rows", () => {
  test("reports a call of the method inside the scoped paths", async () => {
    expect(await lint("apps/api/src/lib/sweep.ts")).toEqual([1, 2]);
  });

  test("leaves the owner and its allowed files alone", async () => {
    expect(await lint("apps/api/src/lib/bullmq-requeue.ts")).toEqual([]);
    expect(await lint("apps/api/src/lib/allowed.ts")).toEqual([]);
  });

  test("leaves files outside the scoped paths alone", async () => {
    expect(await lint("apps/web/src/store.ts")).toEqual([]);
  });
});
