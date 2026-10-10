// A member's cell edit has one writer: `apps/api/src/lib/fields/write-field.ts`
// checks the member's authority, takes the entity row lock before the cell
// lock, marks the cell as manually edited and records the audit event in the
// same transaction. A second module that writes `fields` or `cellMetadata`
// itself can set a cell without any of that, so writes to those tables are
// confined to the owner and to the modules listed below, each of which writes
// them as part of a different operation (a new document version, an
// extraction run, a manual flag) under its own rules.
//
// Detection follows `no-direct-property-table-write`: a `.insert(T)`,
// `.update(T)` or `.delete(T)` call whose argument resolves, through real
// scope analysis, to a value import of `fields` or `cellMetadata` from
// `@/api/db/schema` (aliases included). A same-named local that never imports
// the table is not tracked.
//
// Test files are out of scope: `*.test.ts`, anything under
// `apps/api/src/tests/` and `rls-helpers.ts` build fixture rows directly.
//
// Adding a writer: prefer calling `writeFieldValue`. A module that writes
// these tables for an operation other than a member's cell edit is added to
// the list below with the reason, where review sees it.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  filenameForContext,
  getImportedName,
  isAstNode,
  isIdentifier,
  isIdentifierReference,
  isStringLiteral,
  resolveVariable,
} from "./utils.ts";

const GUARDED_TABLES = new Set(["fields", "cellMetadata"]);

const WRITE_METHODS = ["insert", "update", "delete"] as const;

const OWNER_FILE = "apps/api/src/lib/fields/write-field.ts";

// Writers of the field tables for operations other than a member's cell edit.
const OTHER_OPERATION_WRITERS = new Set([
  // Copies a document's cells into a new version or a new document.
  "apps/api/src/handlers/entities/upload.ts",
  "apps/api/src/handlers/entities/finalize-desktop-edit-session.ts",
  "apps/api/src/handlers/entities/versions/restore.ts",
  "apps/api/src/handlers/entities/rename-operation.ts",
  "apps/api/src/lib/entities/create-from-buffer.ts",
  "apps/api/src/lib/uploads/entity-create.ts",
  "apps/api/src/lib/entity-versions/write-file-version.ts",
  "apps/api/src/lib/entity-versions/insert-entity-batch.ts",
  // Extraction runs and derived files, which honour the manual-edit lock.
  "apps/api/src/lib/workflow-queue.ts",
  "apps/api/src/lib/workflow/orphan-cells.ts",
  "apps/api/src/lib/file-derivative-queue.ts",
  // Manual flags and column flags on a cell, not its value.
  "apps/api/src/handlers/fields/cell-metadata/update.ts",
  "apps/api/src/handlers/fields/column-flag/update.ts",
]);

const FIXTURE_FILE_SUFFIX =
  ".oxlint-plugins/__fixtures__/no-direct-field-write.fixture.ts";

const isOwnerFile = (filename: string): boolean =>
  filename.endsWith(OWNER_FILE) ||
  [...OTHER_OPERATION_WRITERS].some((writer) => filename.endsWith(writer));

const isApiTestSupportFile = (filename: string): boolean =>
  /\.test\.tsx?$/u.test(filename) ||
  filename.includes("apps/api/src/tests/") ||
  filename.includes("apps/api/src/test/") ||
  filename.endsWith("rls-helpers.ts");

export default eslintCompatPlugin({
  meta: { name: "no-direct-field-write" },
  rules: {
    "no-direct-field-write": {
      meta: {
        type: "problem",
        messages: {
          directWrite:
            "Write a document's field values through writeFieldValue " +
            "(apps/api/src/lib/fields/write-field.ts), which checks the " +
            "member's authority, keeps the cell lock and records the audit " +
            "event.",
        },
      },
      createOnce(context) {
        const isGuardedTableReference = (node: unknown): boolean => {
          if (!isIdentifierReference(node)) {
            return false;
          }
          const variable = resolveVariable(context, node);
          if (variable === null) {
            return false;
          }
          return variable.defs.some(
            (definition) =>
              definition.type === "ImportBinding" &&
              isAstNode(definition.node) &&
              definition.node.type === "ImportSpecifier" &&
              definition.node.importKind !== "type" &&
              isAstNode(definition.parent) &&
              definition.parent.type === "ImportDeclaration" &&
              definition.parent.importKind !== "type" &&
              isStringLiteral(definition.parent.source) &&
              definition.parent.source.value === "@/api/db/schema" &&
              GUARDED_TABLES.has(getImportedName(definition.node) ?? ""),
          );
        };

        return {
          before() {
            const filename = filenameForContext(context);
            if (filename.endsWith(FIXTURE_FILE_SUFFIX)) {
              return true;
            }
            return (
              filename.includes("apps/api/src/") &&
              !isApiTestSupportFile(filename) &&
              !isOwnerFile(filename)
            );
          },
          CallExpression(node) {
            const callee = node.callee;
            if (
              !isAstNode(callee) ||
              callee.type !== "MemberExpression" ||
              !WRITE_METHODS.some((method) =>
                isIdentifier(callee.property, method),
              ) ||
              !isGuardedTableReference(node.arguments.at(0))
            ) {
              return;
            }
            context.report({ node, messageId: "directWrite" });
          },
        };
      },
    },
  },
});
