// Chat fixture guard.
//
// A messages snapshot written by hand in a test agrees with TanStack's engine
// only until the engine changes. Valid-path snapshots come from
// the builders in `apps/api/src/tests/helpers/chat-fixtures.ts`, which run the
// engine's own converters. This guard rejects a `MESSAGES_SNAPSHOT` object
// literal in any chat test or test helper outside that owner, unless it is an
// argument of `unsafeFixture(reason, ...)`, the explicit escape for malformed
// input and exhaustive state matrices. Hand-built UI state matrices are not
// in scope.
//
// Test files that predate the builders are listed in
// scripts/chat-fixture-guard-ledger.json. The ledger only shrinks: a listed
// file that no longer builds a snapshot by hand fails as stale, and a new file
// that does fails as unlisted.
//
// Modes:
//   bun scripts/chat-fixture-guard.ts              check the tree (CI gate)
//   bun scripts/chat-fixture-guard.ts --self-test  prove the detector fires
//   bun scripts/chat-fixture-guard.ts --write      rewrite the ledger from the tree

import { panic } from "better-result";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const LEDGER_REL = "scripts/chat-fixture-guard-ledger.json";
const OWNER_REL = "apps/api/src/tests/helpers/chat-fixtures.ts";
const SCAN_GLOBS = [
  "apps/api/src/**/*.test.ts",
  "apps/api/src/tests/**/*.ts",
  "apps/web/src/**/*.test.ts",
  "apps/web/src/**/*.test.tsx",
] as const;
const SNAPSHOT_TYPE = "MESSAGES_SNAPSHOT";
const ESCAPE_CALL = "unsafeFixture";

export type SnapshotLiteral = { line: number; path: string };

const isSnapshotType = (node: ts.Expression): boolean =>
  (ts.isStringLiteral(node) && node.text === SNAPSHOT_TYPE) ||
  (ts.isPropertyAccessExpression(node) && node.name.text === SNAPSHOT_TYPE);

const isInsideEscape = (node: ts.Node): boolean => {
  for (
    let current = node.parent;
    current !== undefined;
    current = current.parent
  ) {
    if (
      ts.isCallExpression(current) &&
      ts.isIdentifier(current.expression) &&
      current.expression.text === ESCAPE_CALL
    ) {
      return true;
    }
  }
  return false;
};

/** The snapshot object literals `source` builds outside the escape. */
export const findSnapshotLiterals = (
  relativePath: string,
  source: string,
): SnapshotLiteral[] => {
  const file = ts.createSourceFile(
    relativePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: SnapshotLiteral[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isObjectLiteralExpression(node) &&
      node.properties.some(
        (property) =>
          ts.isPropertyAssignment(property) &&
          property.name.getText(file) === "type" &&
          isSnapshotType(property.initializer),
      ) &&
      !isInsideEscape(node)
    ) {
      found.push({
        line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
        path: relativePath,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
};

export type GuardReport = { stale: string[]; unlisted: SnapshotLiteral[] };

/** Compares what the tree builds by hand with the ledger. */
export const compareWithLedger = ({
  found,
  ledger,
}: {
  found: readonly SnapshotLiteral[];
  ledger: readonly string[];
}): GuardReport => {
  const listed = new Set(ledger);
  const offending = new Set(found.map(({ path: file }) => file));
  return {
    stale: ledger.filter((file) => !offending.has(file)),
    unlisted: found.filter(({ path: file }) => !listed.has(file)),
  };
};

const scanTree = async (): Promise<SnapshotLiteral[]> => {
  const found: SnapshotLiteral[] = [];
  const seen = new Set<string>();
  for (const pattern of SCAN_GLOBS) {
    for await (const relativePath of new Bun.Glob(pattern).scan({
      cwd: REPO_ROOT,
    })) {
      if (
        seen.has(relativePath) ||
        relativePath === OWNER_REL ||
        relativePath.includes("node_modules")
      ) {
        continue;
      }
      seen.add(relativePath);
      const source = await Bun.file(path.join(REPO_ROOT, relativePath)).text();
      if (source.includes(SNAPSHOT_TYPE)) {
        found.push(...findSnapshotLiterals(relativePath, source));
      }
    }
  }
  return found.toSorted(
    (left, right) =>
      left.path.localeCompare(right.path) || left.line - right.line,
  );
};

const readLedger = (): string[] => {
  const parsed: unknown = JSON.parse(
    readFileSync(path.join(REPO_ROOT, LEDGER_REL), "utf-8"),
  );
  if (!Array.isArray(parsed) || !parsed.every((e) => typeof e === "string")) {
    return panic(`${LEDGER_REL} must be a JSON array of file paths`);
  }
  return parsed;
};

const check = async (): Promise<number> => {
  const found = await scanTree();
  const ledger = readLedger();
  const { stale, unlisted } = compareWithLedger({ found, ledger });
  if (stale.length === 0 && unlisted.length === 0) {
    console.log(
      `chat fixture guard: OK. ${String(ledger.length)} listed files still build snapshots by hand; no new ones.`,
    );
    return 0;
  }
  for (const { line, path: file } of unlisted) {
    console.error(
      `  ${file}:${String(line)}: a hand-built messages snapshot. Build it with ${OWNER_REL}, or wrap malformed input in ${ESCAPE_CALL}(reason, ...).`,
    );
  }
  for (const file of stale) {
    console.error(
      `  ${file}: listed in ${LEDGER_REL} but builds no snapshot by hand any more; remove the entry.`,
    );
  }
  return 1;
};

const write = async (): Promise<number> => {
  const files = [...new Set((await scanTree()).map(({ path: file }) => file))];
  writeFileSync(
    path.join(REPO_ROOT, LEDGER_REL),
    `${JSON.stringify(files, null, 2)}\n`,
  );
  console.log(`chat fixture guard: wrote ${String(files.length)} files.`);
  return 0;
};

const selfTest = (): number => {
  const failures: string[] = [];
  const expectCount = (label: string, source: string, count: number) => {
    const found = findSnapshotLiterals("fixture.test.ts", source).length;
    if (found !== count) {
      failures.push(
        `${label}: found ${String(found)}, expected ${String(count)}`,
      );
    }
  };
  expectCount(
    "an enum-typed snapshot literal",
    "const s = { type: EventType.MESSAGES_SNAPSHOT, messages: [] };",
    1,
  );
  expectCount(
    "a string-typed snapshot literal",
    'const s = { messages: [], type: "MESSAGES_SNAPSHOT" };',
    1,
  );
  expectCount(
    "a snapshot inside the escape",
    'const s = unsafeFixture("a snapshot no engine emits", { type: EventType.MESSAGES_SNAPSHOT, messages: [] });',
    0,
  );
  expectCount(
    "a comparison with the snapshot type",
    "if (chunk.type === EventType.MESSAGES_SNAPSHOT) { use(chunk); }",
    0,
  );
  expectCount(
    "another chunk literal",
    "const s = { type: EventType.RUN_FINISHED, runId: 'r' };",
    0,
  );
  const report = compareWithLedger({
    found: [
      { line: 1, path: "listed.test.ts" },
      { line: 2, path: "new.test.ts" },
    ],
    ledger: ["listed.test.ts", "migrated.test.ts"],
  });
  if (
    JSON.stringify(report.stale) !== JSON.stringify(["migrated.test.ts"]) ||
    JSON.stringify(report.unlisted.map(({ path: file }) => file)) !==
      JSON.stringify(["new.test.ts"])
  ) {
    failures.push(
      `ledger comparison must report the migrated and the new file: ${JSON.stringify(report)}`,
    );
  }
  if (failures.length === 0) {
    console.log("chat-fixture-guard --self-test: PASS");
    return 0;
  }
  for (const failure of failures) {
    console.error(`  ${failure}`);
  }
  return 1;
};

if (import.meta.main) {
  const mode = process.argv[2];
  if (mode === "--self-test") {
    process.exit(selfTest());
  }
  process.exit(mode === "--write" ? await write() : await check());
}
