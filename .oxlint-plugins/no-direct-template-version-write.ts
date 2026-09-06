// Template-version rows and their stored DOCX object form one publication
// contract. Production writers must use the initial-template creator or the
// existing-template coordinator so object cleanup intents, optimistic checks,
// and row publication cannot drift apart.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  filenameForContext,
  getImportedName,
  getImportLocalName,
  getPropertyName,
  isIdentifier,
  isStringLiteral,
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

const isTestFile = (filename: string): boolean =>
  filename.includes("/tests/") ||
  filename.includes("/__tests__/") ||
  /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(filename);

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
        const directBindings = new Set<string>();
        const namespaceBindings = new Set<string>();

        const isTemplateVersionsTable = (node: unknown): boolean => {
          const table = unwrapExpression(node);
          if (isIdentifier(table)) {
            return directBindings.has(table.name);
          }
          return (
            table?.type === "MemberExpression" &&
            isIdentifier(table.object) &&
            namespaceBindings.has(table.object.name) &&
            getPropertyName(table.property) === TABLE_NAME
          );
        };

        return {
          before() {
            directBindings.clear();
            namespaceBindings.clear();
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
          ImportDeclaration(node) {
            if (
              !isStringLiteral(node.source) ||
              !isSchemaModule(node.source.value) ||
              !Array.isArray(node.specifiers)
            ) {
              return;
            }
            for (const specifier of node.specifiers) {
              if (
                specifier.type === "ImportNamespaceSpecifier" &&
                isIdentifier(specifier.local)
              ) {
                namespaceBindings.add(specifier.local.name);
                continue;
              }
              if (getImportedName(specifier) !== TABLE_NAME) {
                continue;
              }
              const localName = getImportLocalName(specifier);
              if (localName !== null) {
                directBindings.add(localName);
              }
            }
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
