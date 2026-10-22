import { expect, test } from "bun:test";
import path from "node:path";
import ts from "typescript6";

type FixtureUsageViolation = {
  file: string;
  line: number;
};

// These suites predate the setup-only contract. Keep the census monotonic while
// their module-level or per-test fixture lifecycles are migrated separately.
const LEGACY_FIXTURE_USAGES = new Set([
  "apps/api/src/handlers/chat/provider-wire-transcripts.integration.test.ts:88",
  "apps/api/src/handlers/reports/report-export-queue.integration.test.ts:56",
  "apps/api/src/handlers/templates/fills/create.integration.test.ts:50",
  "apps/api/src/lib/account-audit.test.ts:38",
  "apps/api/src/lib/account-audit.test.ts:88",
  "apps/api/src/lib/account-audit.test.ts:132",
  "apps/api/src/lib/audit-log-details.db.test.ts:88",
  "apps/api/src/lib/bilingual/run-queue.test.ts:30",
  "apps/api/src/lib/bilingual/run-worker-inputs.integration.test.ts:57",
  "apps/api/src/lib/document-review/run-inputs.test.ts:31",
  "apps/api/src/lib/document-review/run-queue.test.ts:37",
  "apps/api/src/lib/document-review/run-worker-inputs.integration.test.ts:50",
  "apps/api/src/lib/document-translation/run-worker-inputs.integration.test.ts:57",
  "apps/api/src/lib/lists/verification/run-worker-inputs.integration.test.ts:40",
  "apps/api/src/lib/report-export-enqueue.db.test.ts:62",
  "apps/api/src/lib/report-export-recovery.db.test.ts:28",
  "apps/api/src/lib/scheduler/tasks/chat-thread-compactor.integration.test.ts:55",
  "apps/api/src/lib/scheduler/tasks/file-comparison-sweep.test.ts:172",
  "apps/api/src/lib/scheduler/tasks/file-derivative-repair.test.ts:60",
  "apps/api/src/lib/scheduler/tasks/memory-extractor.integration.test.ts:53",
  "apps/api/src/lib/style-set-package-cleanup-queue.db.test.ts:58",
  "apps/api/src/lib/style-set-package-cleanup-reference.test.ts:21",
  "apps/api/src/lib/tasks/update-task-eligibility.integration.test.ts:43",
  "apps/api/src/lib/workflow-queue.integration.test.ts:57",
  "apps/api/src/tests/helpers/chat-thread-invariants.test.ts:486",
  "apps/api/src/tests/security/rls-scoped-db.test.ts:35",
]);

const findFixtureUsageViolations = async () => {
  const violations: FixtureUsageViolation[] = [];
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
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    const visit = (node: ts.Node, insideBeforeAll: boolean) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "getRlsFixture" &&
        !insideBeforeAll
      ) {
        const line =
          sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        if (!LEGACY_FIXTURE_USAGES.has(`${file}:${line}`)) {
          violations.push({ file, line });
        }
      }

      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "beforeAll"
      ) {
        node.forEachChild((child) =>
          visit(child, child === node.arguments.at(0) || insideBeforeAll),
        );
        return;
      }

      node.forEachChild((child) => visit(child, insideBeforeAll));
    };

    visit(sourceFile, false);
  }

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
