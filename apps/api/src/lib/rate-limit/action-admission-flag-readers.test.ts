import { describe, expect, test } from "bun:test";
import ts from "typescript";

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
  "lib/rate-limit/tenant-action-boundary.ts": 1,
  // The size-bound wrapper and the admission store warmup.
  "server.ts": 2,
  // A run without an actor has no caller to admit or count.
  "lib/flows/start-flow-run.ts": 1,
  // Cost-record storage and its retention, not admission.
  "lib/usage/action-costs/recorder.ts": 1,
  "lib/scheduler/jobs.ts": 1,
  "lib/scheduler/tasks/action-cost-retention.ts": 1,
} as const;

const readsFlag = (node: ts.Node) =>
  (ts.isStringLiteral(node) &&
    ts.isCallExpression(node.parent) &&
    ADMISSION_FLAGS.has(node.text)) ||
  (ts.isPropertyAccessExpression(node) && ADMISSION_FLAGS.has(node.name.text));

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
      const tree = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node: ts.Node): void => {
        if (readsFlag(node)) {
          reads[file] = (reads[file] ?? 0) + 1;
        }
        ts.forEachChild(node, visit);
      };
      visit(tree);
    }
    expect(reads).toEqual(ALLOWED_FLAG_READS);
  });
});
