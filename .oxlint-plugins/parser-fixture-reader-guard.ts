import { eslintCompatPlugin } from "@oxlint/plugins";

import { PARSER_FIXTURE_OWNERS } from "../apps/api/src/tests/helpers/parser-fixture-owners.ts";
import {
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
              for (const specifier of statement.specifiers) {
                if (!isAstNode(specifier)) {
                  continue;
                }
                if (
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
            const name = getPropertyName(node.property);
            if (name === null || !PARSERS.has(name)) {
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
              !isIdentifierReference(node)
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
