import ts from "typescript6";

export const TEST_BATCH_KIND = {
  db: "db",
  heavyLogic: "heavy-logic",
  heavyDb: "heavy-db",
  moduleMock: "module-mock",
  regular: "regular",
} as const;

export type TestBatchKind =
  (typeof TEST_BATCH_KIND)[keyof typeof TEST_BATCH_KIND];

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
