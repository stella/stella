import { expect, test } from "bun:test";
import path from "node:path";

import { parseSource, walk } from "@stll/scripts/src/syntax-tree";
import type { CallExpression } from "@stll/scripts/src/syntax-tree";

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

/** Lines of acquisitions outside bare or fixture-owned suite setup. */
const callsOutsideSetup = (file: string, source: string): number[] => {
  const { locate, program } = parseSource(file, source);
  const constructors = new Set<string>();
  for (const statement of program.body) {
    if (
      statement.type !== "ImportDeclaration" ||
      statement.source.value !== "@/api/tests/helpers/test-state" ||
      statement.importKind === "type"
    ) {
      continue;
    }
    for (const specifier of statement.specifiers) {
      if (
        specifier.type === "ImportSpecifier" &&
        specifier.importKind !== "type" &&
        specifier.imported.type === "Identifier" &&
        specifier.imported.name === "createTestState"
      ) {
        constructors.add(specifier.local.name);
      }
    }
  }
  const fixtures = new Set<string>();
  const suiteSetups = new Set<CallExpression>();
  // Top-level const bindings and registrations cannot shadow their fixture owner.
  for (const statement of program.body) {
    if (
      statement.type === "VariableDeclaration" &&
      statement.kind === "const"
    ) {
      for (const declaration of statement.declarations) {
        if (
          declaration.id.type === "Identifier" &&
          declaration.init?.type === "CallExpression" &&
          declaration.init.callee.type === "Identifier" &&
          constructors.has(declaration.init.callee.name)
        ) {
          fixtures.add(declaration.id.name);
        }
      }
    }
    if (
      statement.type === "ExpressionStatement" &&
      statement.expression.type === "CallExpression" &&
      statement.expression.callee.type === "MemberExpression" &&
      !statement.expression.callee.computed &&
      statement.expression.callee.property.type === "Identifier" &&
      statement.expression.callee.property.name === "beforeAll" &&
      statement.expression.callee.object.type === "Identifier" &&
      fixtures.has(statement.expression.callee.object.name)
    ) {
      suiteSetups.add(statement.expression);
    }
  }
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
        ((ancestor.callee.type === "Identifier" &&
          ancestor.callee.name === "beforeAll") ||
          suiteSetups.has(ancestor)) &&
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

const fixtureImport =
  'import { createTestState as createState } from "@/api/tests/helpers/test-state";';

test("RLS fixture setup follows the imported fixture owner and registration", () => {
  for (const source of [
    "beforeAll(async () => { await getRlsFixture(); });",
    `${fixtureImport}
const state = createState({ file: import.meta.path, config: env });
state.beforeAll(async () => { await getRlsFixture(); });`,
  ]) {
    expect(callsOutsideSetup("fixture.test.ts", source)).toEqual([]);
  }
});

test("an empty setup never authorizes an acquisition in a test", () => {
  for (const setup of [
    "beforeAll(async () => {});",
    `${fixtureImport}
const state = createState({ file: import.meta.path, config: env });
state.beforeAll(async () => {});`,
  ]) {
    const source = `${setup}
test("acquires too late", async () => { await getRlsFixture(); });`;
    expect(callsOutsideSetup("fixture.test.ts", source)).toEqual([
      source.split("\n").length,
    ]);
  }
});

test("only the owning fixture can register fixture suite setup", () => {
  for (const setup of [
    "const state = otherFactory();",
    "const state = { beforeAll: (callback) => callback() };",
    'import { createTestState } from "other-owner"; const state = createTestState();',
    `${fixtureImport} let state = createState();`,
  ]) {
    const source = `${setup}
state.beforeAll(async () => { await getRlsFixture(); });`;
    expect(callsOutsideSetup("fixture.test.ts", source)).toEqual([
      source.split("\n").length,
    ]);
  }
});

test("fixture names inside a test cannot borrow a file's setup registration", () => {
  const source = `${fixtureImport}
const state = createState({ file: import.meta.path, config: env });
test("shadowed fixture", async () => {
  const state = otherFactory();
  state.beforeAll(async () => { await getRlsFixture(); });
});`;
  expect(callsOutsideSetup("fixture.test.ts", source)).toEqual([5]);
});
