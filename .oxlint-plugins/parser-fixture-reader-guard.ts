import { eslintCompatPlugin } from "@oxlint/plugins";
import path from "node:path";

import { PARSER_FIXTURE_OWNERS } from "../apps/api/src/tests/helpers/parser-fixture-owners.ts";
import {
  filenameForContext,
  getImportedName,
  getImportLocalName,
  getPropertyName,
  isAstNode,
  isIdentifier,
  isIdentifierReference,
  isStringLiteral,
  resolveVariable,
} from "./utils.ts";

const PARSERS = new Set<string>(Object.values(PARSER_FIXTURE_OWNERS).flat());

/** The modules that own case-law parsers: ingestion parsers and adapters, legal-search parsers. */
/** How a report names a parser read through a computed, non-literal key. */
const COMPUTED_KEY = "a computed parser key";

/**
 * The property a member access reads. A computed key is read only as a
 * string literal: an identifier key names a value, not the property, so it
 * could hide a parser.
 */
const memberName = (node: { computed: boolean; property: unknown }) => {
  if (!node.computed) {
    return getPropertyName(node.property);
  }
  return isStringLiteral(node.property) ? node.property.value : COMPUTED_KEY;
};

const PARSER_MODULE_PATH =
  /(?:^|\/)(?:handlers\/case-law\/ingestion\/(?:parsers|adapters)|lib\/legal-search\/parsers)(?:\/[^/]+)+$/u;

/**
 * Whether an import names a parser-owning module. A relative source resolves
 * against the importing file, so a stub beside a test that exports a parser's
 * name is not mistaken for the parser.
 */
const importsParserModule = (source: string, filename: string): boolean =>
  PARSER_MODULE_PATH.test(
    source.startsWith(".")
      ? path.posix.join(path.posix.dirname(filename), source)
      : source,
  );

export default eslintCompatPlugin({
  meta: { name: "parser-fixture-reader-guard" },
  rules: {
    "parser-fixture-reader-guard": {
      meta: {
        type: "problem",
        messages: {
          unguarded:
            "Wrap imported AST parser {{name}} with guardParser from tests/helpers/parser-reader-guard before using it in fixtures.",
        },
      },
      createOnce(context) {
        const bindings = new Set<string>();
        const guards = new Set<string>();
        const namespaces = new Set<string>();
        return {
          before() {
            bindings.clear();
            guards.clear();
            namespaces.clear();
          },
          Program(node) {
            if (!Array.isArray(node.body)) {
              return;
            }
            for (const statement of node.body) {
              if (
                !isAstNode(statement) ||
                statement.type !== "ImportDeclaration" ||
                !Array.isArray(statement.specifiers)
              ) {
                continue;
              }
              const fromParserModule =
                isStringLiteral(statement.source) &&
                importsParserModule(
                  statement.source.value,
                  filenameForContext(context),
                );
              for (const specifier of statement.specifiers) {
                if (!isAstNode(specifier)) {
                  continue;
                }
                if (
                  fromParserModule &&
                  specifier.type === "ImportNamespaceSpecifier" &&
                  isIdentifier(specifier.local)
                ) {
                  namespaces.add(specifier.local.name);
                }
                const imported = getImportedName(specifier);
                const local = getImportLocalName(specifier);
                if (
                  imported === "guardParser" &&
                  local !== null &&
                  isStringLiteral(statement.source) &&
                  /(?:^|\/)parser-reader-guard(?:\.ts)?$/u.test(
                    statement.source.value,
                  )
                ) {
                  guards.add(local);
                }
                if (
                  fromParserModule &&
                  imported !== null &&
                  local !== null &&
                  PARSERS.has(imported)
                ) {
                  bindings.add(local);
                }
              }
            }
          },
          MemberExpression(node) {
            if (
              !isIdentifier(node.object) ||
              !namespaces.has(node.object.name)
            ) {
              return;
            }
            const name = memberName(node);
            if (
              name === null ||
              (name !== COMPUTED_KEY && !PARSERS.has(name))
            ) {
              return;
            }
            const parent = node.parent;
            if (
              isAstNode(parent) &&
              parent.type === "CallExpression" &&
              isIdentifier(parent.callee) &&
              guards.has(parent.callee.name) &&
              resolveVariable(context, parent.callee)?.defs.some(
                (definition) => definition.type === "ImportBinding",
              ) === true &&
              Array.isArray(parent.arguments) &&
              parent.arguments.at(0) === node
            ) {
              return;
            }
            context.report({ node, messageId: "unguarded", data: { name } });
          },
          Identifier(node) {
            if (
              !isIdentifier(node) ||
              !bindings.has(node.name) ||
              !isIdentifierReference(node) ||
              resolveVariable(context, node)?.defs.some(
                (definition) => definition.type === "ImportBinding",
              ) !== true
            ) {
              return;
            }
            const parent = node.parent;
            if (isAstNode(parent) && parent.type === "ImportSpecifier") {
              return;
            }
            if (
              isAstNode(parent) &&
              parent.type === "CallExpression" &&
              isIdentifier(parent.callee) &&
              guards.has(parent.callee.name) &&
              resolveVariable(context, parent.callee)?.defs.some(
                (definition) => definition.type === "ImportBinding",
              ) === true &&
              Array.isArray(parent.arguments) &&
              parent.arguments.at(0) === node
            ) {
              return;
            }
            if (isAstNode(parent) && parent.type === "TSTypeQuery") {
              return;
            }
            context.report({
              node,
              messageId: "unguarded",
              data: { name: node.name },
            });
          },
        };
      },
    },
  },
});
