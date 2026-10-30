import { describe, expect, test } from "bun:test";

import { type Node, parseSource, walk } from "@stll/scripts/src/syntax-tree";

const srcRoot = new URL("../../", import.meta.url);

const ADMISSION_FLAGS = new Set([
  "FEATURE_ACTION_ADMISSION",
  "FEATURE_ACTION_COST_RECORDS",
]);

/**
 * Every read of an admission flag outside `withActionAdmission`, with its
 * count. A caller that skips `withActionAdmission` while a flag is off also
 * skips the budgets it applies in either state (the demo account's daily cap),
 * so call sites must not branch on these flags around it.
 */
const ALLOWED_FLAG_READS = {
  // The owner: its disabled branch runs the action and still applies the
  // demo budget; queued period reservation is a no-op while disabled.
  "lib/rate-limit/action-admission.ts": 2,
  // Request and response size bounds, not action counting.
  "lib/rate-limit/action-size-limits.ts": 1,
  // The size-bound middleware.
  "lib/rate-limit/tenant-action-boundary.ts": 1,
  // The admission store warmup.
  "server.ts": 1,
  // A run without an actor has no caller to admit or count.
  "lib/flows/start-flow-run.ts": 1,
  // Cost-record storage and its retention, not admission.
  "lib/usage/action-costs/recorder.ts": 1,
  "lib/scheduler/jobs.ts": 1,
  "lib/scheduler/tasks/action-cost-retention.ts": 1,
} as const;

const readsFlag = (node: Node, parent: Node | undefined) =>
  (node.type === "Literal" &&
    typeof node.value === "string" &&
    parent?.type === "CallExpression" &&
    ADMISSION_FLAGS.has(node.value)) ||
  (node.type === "MemberExpression" &&
    !node.computed &&
    node.property.type === "Identifier" &&
    ADMISSION_FLAGS.has(node.property.name));

describe("action admission flag readers", () => {
  test("only the admission owner and listed non-counting paths read admission flags", async () => {
    const reads: Record<string, number> = {};
    for (const file of new Bun.Glob("**/*.ts").scanSync({
      cwd: srcRoot.pathname,
    })) {
      if (file.includes(".test.") || file.startsWith("tests/")) {
        continue;
      }
      const source = await Bun.file(new URL(file, srcRoot)).text();
      if (![...ADMISSION_FLAGS].some((flag) => source.includes(flag))) {
        continue;
      }
      walk(parseSource(file, source).program, (node, ancestors) => {
        if (readsFlag(node, ancestors.at(-1))) {
          reads[file] = (reads[file] ?? 0) + 1;
        }
      });
    }
    expect(reads).toEqual(ALLOWED_FLAG_READS);
  });
});
