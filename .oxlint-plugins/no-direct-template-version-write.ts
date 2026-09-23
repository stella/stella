// Template-version rows and their stored DOCX object form one publication
// contract. Production writers must use the initial-template creator or the
// existing-template coordinator so object cleanup intents, optimistic checks,
// and row publication cannot drift apart.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  filenameForContext,
  getImportedName,
  getPropertyName,
  isAstNode,
  isIdentifier,
  isIdentifierReference,
  isStringLiteral,
  isTestFile,
  resolveVariable,
  unwrapExpression,
} from "./utils.ts";

const RULE_NAME = "no-direct-template-version-write";
const TABLE_NAME = "templateVersions";
const OWNER_PATHS = [
  "apps/api/src/lib/templates/create-template.ts",
  "apps/api/src/lib/templates/write-template.ts",
] as const;
const FIXTURE_PATH =
  ".oxlint-plugins/__fixtures__/no-direct-template-version-write.fixture.ts";
const MUTATION_METHODS = new Set(["delete", "insert", "update"]);

const isSchemaModule = (specifier: string): boolean =>
  specifier === "@/api/db/schema" ||
  /(?:^|\/)db\/schema(?:\/templates)?(?:\.ts)?$/u.test(specifier);

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        messages: {
          directWrite:
            "Write template-version rows through create-template.ts or write-template.ts so DOCX publication, cleanup intents, and optimistic checks stay coordinated.",
        },
        schema: [],
      },
      createOnce(context) {
        const isSchemaImport = (
          identifier: unknown,
          importKind: "named" | "namespace",
        ): boolean => {
          if (!isIdentifierReference(identifier)) {
            return false;
          }
          const variable = resolveVariable(context, identifier);
          if (variable === null) {
            return false;
          }
          return variable.defs.some((definition) => {
            if (
              definition.type !== "ImportBinding" ||
              !isAstNode(definition.node) ||
              !isAstNode(definition.parent) ||
              definition.parent.type !== "ImportDeclaration" ||
              definition.parent.importKind === "type" ||
              !isStringLiteral(definition.parent.source) ||
              !isSchemaModule(definition.parent.source.value)
            ) {
              return false;
            }
            if (importKind === "namespace") {
              return definition.node.type === "ImportNamespaceSpecifier";
            }
            return (
              definition.node.type === "ImportSpecifier" &&
              definition.node.importKind !== "type" &&
              getImportedName(definition.node) === TABLE_NAME
            );
          });
        };

        const isTemplateVersionsTable = (node: unknown): boolean => {
          const table = unwrapExpression(node);
          if (isIdentifier(table)) {
            return isSchemaImport(table, "named");
          }
          return (
            table?.type === "MemberExpression" &&
            isSchemaImport(table.object, "namespace") &&
            getPropertyName(table.property) === TABLE_NAME
          );
        };

        return {
          before() {
            const filename = filenameForContext(context);
            if (filename.endsWith(FIXTURE_PATH)) {
              return true;
            }
            return (
              filename.includes("apps/api/src/") &&
              !OWNER_PATHS.some((ownerPath) => filename.endsWith(ownerPath)) &&
              !isTestFile(filename)
            );
          },
          CallExpression(node) {
            const callee = unwrapExpression(node.callee);
            if (
              callee?.type !== "MemberExpression" ||
              !MUTATION_METHODS.has(getPropertyName(callee.property) ?? "") ||
              !Array.isArray(node.arguments) ||
              !isTemplateVersionsTable(node.arguments.at(0))
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
