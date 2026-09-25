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
// A literal counts however its discriminant is spelled: a quoted or computed
// `type` key, a shorthand `type` or an identifier bound to the snapshot type
// in an enclosing scope, `EventType.MESSAGES_SNAPSHOT` under any import alias
// or element access, and any of these behind `as const`, `satisfies`, a type
// assertion, parentheses or `!`.
//
// Test files that predate the builders are listed in
// scripts/chat-fixture-guard-ledger.json with how many snapshots each builds
// by hand. The ledger only shrinks: a file with more literals than its entry
// (or with none listed) fails, and a file with fewer fails until its entry is
// lowered or removed.
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
  "apps/web/src/**/*.test.{ts,tsx}",
  // Web test helpers: shared test directories, `test-*` and `*-test-*`
  // modules such as `test-setup.ts` or `chat-thread-test-router.tsx`, and the
  // e2e helpers, fixtures and specs.
  "apps/web/src/**/__tests__/**/*.{ts,tsx}",
  "apps/web/src/**/test-utils/**/*.{ts,tsx}",
  "apps/web/src/**/test-*.{ts,tsx}",
  "apps/web/src/**/*-test-*.{ts,tsx}",
  "apps/web/e2e/**/*.{ts,tsx}",
] as const;
const SNAPSHOT_TYPE = "MESSAGES_SNAPSHOT";
const ESCAPE_CALL = "unsafeFixture";

export type SnapshotLiteral = { line: number; path: string };

/** How many bindings `isSnapshotType` follows before giving up. */
const MAX_BINDING_HOPS = 8;

/** `node` without the wrappers that leave its value unchanged. */
const unwrap = (node: ts.Expression): ts.Expression => {
  let current = node;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
};

/** A property name's text, however it is quoted, or undefined if computed
 *  from anything but a literal. */
const propertyNameText = (name: ts.PropertyName): string | undefined => {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name)) {
    const expression = unwrap(name.expression);
    return ts.isStringLiteral(expression) ||
      ts.isNoSubstitutionTemplateLiteral(expression)
      ? expression.text
      : undefined;
  }
  return undefined;
};

/** The initializer of the nearest `const`/`let`/`var` named `name` that
 *  encloses `from`, without a type checker. */
const bindingOf = (from: ts.Node, name: string): ts.Expression | undefined => {
  let scope: ts.Node | undefined = from.parent;
  while (scope !== undefined) {
    const statements =
      ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope)
        ? scope.statements
        : undefined;
    for (const statement of statements ?? []) {
      if (!ts.isVariableStatement(statement)) {
        continue;
      }
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === name &&
          declaration.initializer !== undefined
        ) {
          return declaration.initializer;
        }
      }
    }
    scope = scope.parent;
  }
  return undefined;
};

const isSnapshotType = (node: ts.Expression, hops = 0): boolean => {
  const value = unwrap(node);
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
    return value.text === SNAPSHOT_TYPE;
  }
  if (ts.isPropertyAccessExpression(value)) {
    return value.name.text === SNAPSHOT_TYPE;
  }
  if (ts.isElementAccessExpression(value)) {
    const key = unwrap(value.argumentExpression);
    return (
      (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) &&
      key.text === SNAPSHOT_TYPE
    );
  }
  if (ts.isIdentifier(value) && hops < MAX_BINDING_HOPS) {
    const bound = bindingOf(value, value.text);
    return bound !== undefined && isSnapshotType(bound, hops + 1);
  }
  return false;
};

/** Whether `property` sets the object's `type` to the snapshot type. */
const isSnapshotDiscriminant = (property: ts.ObjectLiteralElementLike) => {
  if (ts.isPropertyAssignment(property)) {
    return (
      propertyNameText(property.name) === "type" &&
      isSnapshotType(property.initializer)
    );
  }
  return (
    ts.isShorthandPropertyAssignment(property) &&
    property.name.text === "type" &&
    isSnapshotType(property.name)
  );
};

const isEscapeCall = (node: ts.Node): boolean =>
  ts.isCallExpression(node) &&
  ts.isIdentifier(node.expression) &&
  node.expression.text === ESCAPE_CALL;

const isInsideEscape = (node: ts.Node): boolean =>
  ts.findAncestor(node.parent, isEscapeCall) !== undefined;

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
      node.properties.some(isSnapshotDiscriminant) &&
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

/** Hand-built snapshot literals per grandfathered file. */
type Ledger = Readonly<Record<string, number>>;

export type GuardReport = {
  /** Files whose literal count fell below their entry. */
  stale: string[];
  /** Literals in files over their entry (all of a file's, if it has none). */
  unlisted: SnapshotLiteral[];
};

const countByFile = (
  found: readonly SnapshotLiteral[],
): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const { path: file } of found) {
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return counts;
};

/** Compares what the tree builds by hand with the ledger. */
export const compareWithLedger = ({
  found,
  ledger,
}: {
  found: readonly SnapshotLiteral[];
  ledger: Ledger;
}): GuardReport => {
  const counts = countByFile(found);
  return {
    stale: Object.entries(ledger).flatMap(([file, allowed]) =>
      (counts.get(file) ?? 0) < allowed ? [file] : [],
    ),
    unlisted: found.filter(
      ({ path: file }) => (counts.get(file) ?? 0) > (ledger[file] ?? 0),
    ),
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

const readLedger = (): Ledger => {
  const parsed: unknown = JSON.parse(
    readFileSync(path.join(REPO_ROOT, LEDGER_REL), "utf-8"),
  );
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return panic(`${LEDGER_REL} must map file paths to literal counts`);
  }
  const ledger: Record<string, number> = {};
  for (const [file, count] of Object.entries(parsed)) {
    if (typeof count !== "number" || !Number.isInteger(count)) {
      return panic(`${LEDGER_REL}: ${file} needs an integer literal count`);
    }
    ledger[file] = count;
  }
  return ledger;
};

const check = async (): Promise<number> => {
  const found = await scanTree();
  const ledger = readLedger();
  const { stale, unlisted } = compareWithLedger({ found, ledger });
  if (stale.length === 0 && unlisted.length === 0) {
    console.log(
      `chat fixture guard: OK. ${String(Object.keys(ledger).length)} listed files still build snapshots by hand; no new ones.`,
    );
    return 0;
  }
  for (const { line, path: file } of unlisted) {
    console.error(
      `  ${file}:${String(line)}: a hand-built messages snapshot beyond the file's ledger entry. Build it with ${OWNER_REL}, or wrap malformed input in ${ESCAPE_CALL}(reason, ...).`,
    );
  }
  for (const file of stale) {
    console.error(
      `  ${file}: builds fewer snapshots by hand than ${LEDGER_REL} allows; lower or remove its entry.`,
    );
  }
  return 1;
};

const write = async (): Promise<number> => {
  const counts = Object.fromEntries(countByFile(await scanTree()));
  writeFileSync(
    path.join(REPO_ROOT, LEDGER_REL),
    `${JSON.stringify(counts, null, 2)}\n`,
  );
  console.log(
    `chat fixture guard: wrote ${String(Object.keys(counts).length)} files.`,
  );
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
  const snapshotForms: readonly [string, string][] = [
    ["a double-quoted key", '{ "type": "MESSAGES_SNAPSHOT", messages: [] }'],
    [
      "a single-quoted key",
      "{ 'type': EventType.MESSAGES_SNAPSHOT, messages: [] }",
    ],
    ["a computed key", '{ ["type"]: "MESSAGES_SNAPSHOT", messages: [] }'],
    [
      "an as-const discriminant",
      '{ type: "MESSAGES_SNAPSHOT" as const, messages: [] }',
    ],
    [
      "a satisfies discriminant",
      "{ type: EventType.MESSAGES_SNAPSHOT satisfies EventType, messages: [] }",
    ],
    [
      "a type-asserted discriminant",
      '{ type: <const>"MESSAGES_SNAPSHOT", messages: [] }',
    ],
    [
      "a parenthesised discriminant",
      "{ type: (EventType.MESSAGES_SNAPSHOT), messages: [] }",
    ],
    [
      "an element access",
      '{ type: EventType["MESSAGES_SNAPSHOT"], messages: [] }',
    ],
    ["an import alias", "{ type: E.MESSAGES_SNAPSHOT, messages: [] }"],
    ["a template literal", "{ type: `MESSAGES_SNAPSHOT`, messages: [] }"],
    [
      "an as-const object",
      '({ type: "MESSAGES_SNAPSHOT", messages: [] }) as const',
    ],
    [
      "a satisfies object",
      "{ type: EventType.MESSAGES_SNAPSHOT, messages: [] } satisfies StreamChunk",
    ],
  ];
  for (const [label, literal] of snapshotForms) {
    expectCount(label, `const s = ${literal};`, 1);
  }
  expectCount(
    "a shorthand type bound to the snapshot type",
    "const type = EventType.MESSAGES_SNAPSHOT; const s = { type, messages: [] };",
    1,
  );
  expectCount(
    "an alias constant two bindings away",
    'const SNAPSHOT = "MESSAGES_SNAPSHOT" as const; const kind = SNAPSHOT; const s = { type: kind, messages: [] };',
    1,
  );
  expectCount(
    "a shorthand type bound in an enclosing function",
    "const build = () => { const type = EventType.MESSAGES_SNAPSHOT; return () => ({ type, messages: [] }); };",
    1,
  );
  expectCount(
    "a shorthand type bound to another chunk type",
    "const type = EventType.RUN_FINISHED; const s = { type, runId: 'r' }; const n = EventType.MESSAGES_SNAPSHOT;",
    0,
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
      { line: 2, path: "grown.test.ts" },
      { line: 3, path: "grown.test.ts" },
      { line: 4, path: "new.test.ts" },
    ],
    ledger: { "grown.test.ts": 1, "listed.test.ts": 1, "migrated.test.ts": 2 },
  });
  if (
    JSON.stringify(report.stale) !== JSON.stringify(["migrated.test.ts"]) ||
    JSON.stringify([
      ...new Set(report.unlisted.map(({ path: file }) => file)),
    ]) !== JSON.stringify(["grown.test.ts", "new.test.ts"])
  ) {
    failures.push(
      `ledger comparison must report the migrated, the grown and the new file: ${JSON.stringify(report)}`,
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
