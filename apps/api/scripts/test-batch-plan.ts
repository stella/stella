import { panic } from "better-result";
import ts from "typescript";

/** The ordinary DB batch stays small without paying one process per file. */
export const DB_TEST_BATCH_SIZE = 3;

/**
 * Property runs multiply the work inside each file, so each PGlite-backed
 * file gets a fresh process. PGlite's WASM allocation is retained for the
 * process lifetime even after a test closes its client.
 */
export const PROPERTY_DB_TEST_BATCH_SIZE = 1;

export const dbTestBatchSize = (propertyOnly: boolean) =>
  propertyOnly ? PROPERTY_DB_TEST_BATCH_SIZE : DB_TEST_BATCH_SIZE;

export const TEST_BATCH_KIND = {
  db: "db",
  heavyLogic: "heavy-logic",
  moduleMock: "module-mock",
  regular: "regular",
} as const;

export type TestBatchKind =
  (typeof TEST_BATCH_KIND)[keyof typeof TEST_BATCH_KIND];

type ClassifyTestBatchOptions = {
  dbBacked: boolean;
  heavyLogic: boolean;
  installsModuleMock: boolean;
  propertyOnly: boolean;
};

/**
 * Select the one execution class a test belongs to. Property DB isolation
 * takes precedence over module-mock batching because either class may retain
 * process-wide state, while a singleton process satisfies both constraints.
 */
export const classifyTestBatch = ({
  dbBacked,
  heavyLogic,
  installsModuleMock,
  propertyOnly,
}: ClassifyTestBatchOptions) => {
  if (propertyOnly && dbBacked) {
    return TEST_BATCH_KIND.db;
  }
  if (installsModuleMock) {
    return TEST_BATCH_KIND.moduleMock;
  }
  if (dbBacked) {
    return TEST_BATCH_KIND.db;
  }
  if (heavyLogic) {
    return TEST_BATCH_KIND.heavyLogic;
  }
  return TEST_BATCH_KIND.regular;
};

/** Split files exactly as the runner will execute them. */
export const composeTestBatches = (
  testFiles: readonly string[],
  batchSize: number,
): string[][] => {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    panic("test batch size must be a positive integer");
  }

  const batches: string[][] = [];
  for (let index = 0; index < testFiles.length; index += batchSize) {
    batches.push(testFiles.slice(index, index + batchSize));
  }
  return batches;
};

const DB_TEST_MARKERS = [
  "tests/security/rls-helpers",
  "tests/security/rls-fixture",
  "tests/security/test-utils",
  "tests/pglite-schema",
  "@/api/db/root",
  "@/api/db/scoped",
  "pglite",
] as const;
const DB_TEST_PATH_RE = /\.(?:integration|db)\.test\.tsx?$/u;

const isRuntimeImport = (statement: ts.ImportDeclaration) => {
  const { importClause } = statement;
  if (importClause === undefined) {
    return true;
  }
  if (importClause.phaseModifier === ts.SyntaxKind.TypeKeyword) {
    return false;
  }
  if (importClause.name !== undefined) {
    return true;
  }
  const { namedBindings } = importClause;
  if (namedBindings === undefined || ts.isNamespaceImport(namedBindings)) {
    return true;
  }
  return (
    namedBindings.elements.length === 0 ||
    namedBindings.elements.some((element) => !element.isTypeOnly)
  );
};

/** Detect tests that create or acquire the embedded PGlite database. */
export const isDbTest = (testPath: string, source: string) => {
  if (DB_TEST_PATH_RE.test(testPath)) {
    return true;
  }
  const sourceFile = ts.createSourceFile(
    testPath,
    source,
    ts.ScriptTarget.Latest,
    false,
    testPath.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  return sourceFile.statements.some((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !isRuntimeImport(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      return false;
    }
    const moduleSpecifier = statement.moduleSpecifier.text;
    return DB_TEST_MARKERS.some((marker) => moduleSpecifier.includes(marker));
  });
};
