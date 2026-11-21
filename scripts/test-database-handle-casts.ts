// Database handles a database test casts by hand for the code under test.
//
// The test databases connect as the owner, which row security never refuses.
// A test that casts one, or a transaction opened on one, to a production
// handle type (`asTestRaw<Transaction>(testDb)`) and hands it to the code
// under test passes even when production, which runs that code on the
// application role, would refuse the same write. The handles in
// apps/api/src/tests/helpers/application-role-db.ts come from the factories
// production takes its handles from, switch every transaction to the
// application role, and need no cast; so each cast left is a handle the test
// built itself, almost always the owner.
//
// Counted, in a file that opens a test database: `asTestRaw<T>(value)` and
// `value as T` where T names a production database handle type. A cast of an
// object literal is a stub that answers no query and is not counted; a cast
// to `RlsDatabase<...>` is the database the production factories wrap, so it
// is not a handle and is not counted either.
import {
  type Node,
  type TSType,
  walk,
} from "../packages/scripts/src/syntax-tree";
import { parseSyntax } from "./parse-memo";

/** Modules a test imports to open a database (PGlite or PostgreSQL). */
const TEST_DATABASE_MODULES = [
  "@/api/tests/security/rls-fixture",
  "@/api/tests/security/test-utils",
  "@/api/tests/gated-test-database",
  "@/api/tests/pglite-test-db",
];

const OPENS_TEST_DATABASE = new RegExp(
  `["'](?:${TEST_DATABASE_MODULES.map((module) => module.replaceAll("/", "\\/")).join("|")})["']`,
  "u",
);

// `Transaction`, `ScopedDb`, `SafeDb`, `RootDatabase`, `ExtractionRunDb`, ...
// Test-only database types and the row-security database are not handles.
const HANDLE_TYPE_NAME = /^(?:Transaction|\w*Db|\w*Database)$/u;
const NOT_A_HANDLE_TYPE_NAME = /^(?:RlsDatabase|\w*Test\w*)$/u;

const typeName = (type: TSType): string | null => {
  if (type.type !== "TSTypeReference") {
    return null;
  }
  const name = type.typeName;
  if (name.type === "Identifier") {
    return name.name;
  }
  return name.type === "TSQualifiedName" ? name.right.name : null;
};

const isHandleType = (type: TSType | undefined): boolean => {
  if (type === undefined) {
    return false;
  }
  const name = typeName(type);
  return (
    name !== null &&
    HANDLE_TYPE_NAME.test(name) &&
    !NOT_A_HANDLE_TYPE_NAME.test(name)
  );
};

const isStub = (value: Node | undefined): boolean =>
  value?.type === "ObjectExpression";

export const countTestDatabaseHandleCasts = (
  content: string,
  file: string,
): number => {
  if (!OPENS_TEST_DATABASE.test(content)) {
    return 0;
  }
  const { program } = parseSyntax({ fileName: file, text: content });
  let count = 0;
  walk(program, (node) => {
    if (node.type === "TSAsExpression") {
      if (isHandleType(node.typeAnnotation) && !isStub(node.expression)) {
        count += 1;
      }
      return;
    }
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "asTestRaw" &&
      isHandleType(node.typeArguments?.params.at(0)) &&
      !isStub(node.arguments.at(0))
    ) {
      count += 1;
    }
  });
  return count;
};
