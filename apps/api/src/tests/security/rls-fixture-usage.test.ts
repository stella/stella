import { expect, test } from "bun:test";
import path from "node:path";

import { parseSource, walk } from "@stll/scripts/src/syntax-tree";

type FixtureUsageViolation = {
  file: string;
  line: number;
};

// These suites predate the setup-only contract: how many acquisitions outside
// `beforeAll` each one still has. Counts only shrink as suites migrate; keyed by
// file so unrelated edits that move lines never fail the census.
const LEGACY_FIXTURE_USAGES: ReadonlyMap<string, number> = new Map([
  [
    "apps/api/src/handlers/chat/provider-wire-transcripts.integration.test.ts",
    1,
  ],
  ["apps/api/src/handlers/reports/report-export-queue.integration.test.ts", 1],
  ["apps/api/src/handlers/templates/fills/create.integration.test.ts", 1],
  ["apps/api/src/lib/account-audit.test.ts", 3],
  ["apps/api/src/lib/audit-log-details.db.test.ts", 1],
  ["apps/api/src/lib/bilingual/run-queue.test.ts", 1],
  ["apps/api/src/lib/bilingual/run-worker-inputs.integration.test.ts", 1],
  ["apps/api/src/lib/document-review/run-inputs.test.ts", 1],
  ["apps/api/src/lib/document-review/run-queue.test.ts", 1],
  ["apps/api/src/lib/document-review/run-worker-inputs.integration.test.ts", 1],
  [
    "apps/api/src/lib/document-translation/run-worker-inputs.integration.test.ts",
    1,
  ],
  [
    "apps/api/src/lib/lists/verification/run-worker-inputs.integration.test.ts",
    1,
  ],
  ["apps/api/src/lib/report-export-enqueue.db.test.ts", 1],
  ["apps/api/src/lib/report-export-recovery.db.test.ts", 1],
  [
    "apps/api/src/lib/scheduler/tasks/chat-thread-compactor.integration.test.ts",
    1,
  ],
  ["apps/api/src/lib/scheduler/tasks/file-comparison-sweep.test.ts", 1],
  ["apps/api/src/lib/scheduler/tasks/file-derivative-repair.test.ts", 1],
  ["apps/api/src/lib/scheduler/tasks/memory-extractor.integration.test.ts", 1],
  ["apps/api/src/lib/style-set-package-cleanup-queue.db.test.ts", 1],
  ["apps/api/src/lib/style-set-package-cleanup-reference.test.ts", 1],
  ["apps/api/src/lib/tasks/update-task-eligibility.integration.test.ts", 1],
  ["apps/api/src/lib/workflow-queue.integration.test.ts", 1],
  ["apps/api/src/tests/helpers/chat-thread-invariants.test.ts", 1],
  ["apps/api/src/tests/security/rls-scoped-db.test.ts", 1],
]);

/** Lines of the `getRlsFixture()` calls outside a `beforeAll` callback. */
const callsOutsideSetup = (file: string, source: string): number[] => {
  const { locate, program } = parseSource(file, source);
  const lines: number[] = [];
  walk(program, (node, ancestors) => {
    if (
      node.type !== "CallExpression" ||
      node.callee.type !== "Identifier" ||
      node.callee.name !== "getRlsFixture"
    ) {
      return;
    }
    const chain = [...ancestors, node];
    const insideBeforeAll = chain.some(
      (ancestor, index) =>
        ancestor.type === "CallExpression" &&
        ancestor.callee.type === "Identifier" &&
        ancestor.callee.name === "beforeAll" &&
        ancestor.arguments.at(0) === chain[index + 1],
    );
    if (!insideBeforeAll) {
      lines.push(locate(node.start).line);
    }
  });
  return lines;
};

const findFixtureUsageViolations = async () => {
  const outsideSetup: FixtureUsageViolation[] = [];
  const testFiles = await Array.fromAsync(
    new Bun.Glob("**/*.test.ts").scan({
      cwd: path.resolve(import.meta.dir, "../../.."),
      onlyFiles: true,
    }),
  );

  for (const relativeFile of testFiles) {
    const file = `apps/api/${relativeFile}`;
    const source = await Bun.file(
      path.resolve(import.meta.dir, "../../..", relativeFile),
    ).text();
    for (const line of callsOutsideSetup(file, source)) {
      outsideSetup.push({ file, line });
    }
  }

  const countByFile = new Map<string, number>();
  for (const { file } of outsideSetup) {
    countByFile.set(file, (countByFile.get(file) ?? 0) + 1);
  }
  // A file over its legacy count reports every call site outside setup, so
  // the failure names the new one among them.
  const violations = outsideSetup.filter(
    ({ file }) =>
      (countByFile.get(file) ?? 0) > (LEGACY_FIXTURE_USAGES.get(file) ?? 0),
  );
  return violations.toSorted((left, right) => {
    if (left.file !== right.file) {
      return left.file < right.file ? -1 : 1;
    }
    return left.line - right.line;
  });
};

test("RLS fixtures are acquired during suite setup", async () => {
  expect(await findFixtureUsageViolations()).toEqual([]);
});
