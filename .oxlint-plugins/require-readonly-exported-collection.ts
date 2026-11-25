// Exported module-level `Map` and `Set` singletons should be typed
// `ReadonlyMap<K, V>` or `ReadonlySet<T>` so callers cannot mutate shared
// state across requests or tests.
//
// Flagged:
//   export const CODES = new Set(["a", "b"]);
//   export const ROUTES = new Map([["a", 1]]);
//
// Accepted:
//   export const CODES: ReadonlySet<string> = new Set(["a", "b"]);
//   export const ROUTES: ReadonlyMap<string, number> = new Map([["a", 1]]);
//   const LOCAL = new Map<string, number>(); // module-private

import { eslintCompatPlugin } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

import { isAstNode, isIdentifierReference, unwrapExpression } from "./utils.ts";

const COLLECTION_TO_READONLY: ReadonlyMap<string, string> = new Map([
  ["Map", "ReadonlyMap"],
  ["Set", "ReadonlySet"],
]);

const collectionKind = (init: unknown): string | null => {
  const expr = unwrapExpression(init);
  if (
    !isAstNode(expr) ||
    expr.type !== "NewExpression" ||
    !isIdentifierReference(expr.callee)
  ) {
    return null;
  }
  return COLLECTION_TO_READONLY.has(expr.callee.name) ? expr.callee.name : null;
};

const hasReadonlyCollectionAnnotation = (
  declarator: ESTree.VariableDeclarator,
  expectedReadonly: string,
): boolean => {
  const id: unknown = declarator.id;
  if (!isAstNode(id)) {
    return false;
  }
  const annotation: unknown = id.typeAnnotation;
  if (!isAstNode(annotation) || annotation.type !== "TSTypeAnnotation") {
    return false;
  }
  const typeNode: unknown = annotation.typeAnnotation;
  return (
    isAstNode(typeNode) &&
    typeNode.type === "TSTypeReference" &&
    isIdentifierReference(typeNode.typeName) &&
    typeNode.typeName.name === expectedReadonly
  );
};

const isModuleLevelExport = (
  declarator: ESTree.VariableDeclarator,
): boolean => {
  const declaration: unknown = declarator.parent;
  if (!isAstNode(declaration) || declaration.kind !== "const") {
    return false;
  }
  const parent: unknown = declaration.parent;
  if (!isAstNode(parent)) {
    return false;
  }
  if (parent.type === "ExportNamedDeclaration") {
    return isAstNode(parent.parent) && parent.parent.type === "Program";
  }
  return false;
};

const isExportedBySpecifier = (
  context: {
    sourceCode: {
      getDeclaredVariables: (
        node: ESTree.VariableDeclarator,
      ) => readonly { references: readonly { identifier: unknown }[] }[];
    };
  },
  declarator: ESTree.VariableDeclarator,
): boolean => {
  const declaration: unknown = declarator.parent;
  if (
    !isAstNode(declaration) ||
    declaration.kind !== "const" ||
    !isAstNode(declaration.parent) ||
    declaration.parent.type !== "Program"
  ) {
    return false;
  }
  return context.sourceCode.getDeclaredVariables(declarator).some((variable) =>
    variable.references.some((reference) => {
      const parent = isAstNode(reference.identifier)
        ? reference.identifier.parent
        : null;
      return (
        isAstNode(parent) &&
        (parent.type === "ExportSpecifier" ||
          parent.type === "ExportDefaultDeclaration")
      );
    }),
  );
};

export default eslintCompatPlugin({
  meta: { name: "require-readonly-exported-collection" },
  rules: {
    "require-readonly-exported-collection": {
      meta: {
        type: "problem",
        messages: {
          mutableExportedCollection:
            "`{{name}}` exports a mutable `{{kind}}`. Annotate it as `{{readonly}}<…>` so callers cannot mutate shared module state.",
        },
        schema: [],
      },
      createOnce(context) {
        return {
          VariableDeclarator(node) {
            const kind = collectionKind(node.init);
            if (kind === null) {
              return;
            }
            const readonlyName = COLLECTION_TO_READONLY.get(kind);
            if (readonlyName === undefined) {
              return;
            }
            if (
              !isModuleLevelExport(node) &&
              !isExportedBySpecifier(context, node)
            ) {
              return;
            }
            if (hasReadonlyCollectionAnnotation(node, readonlyName)) {
              return;
            }
            const id: unknown = node.id;
            context.report({
              node,
              messageId: "mutableExportedCollection",
              data: {
                name: isIdentifierReference(id) ? id.name : "collection",
                kind,
                readonly: readonlyName,
              },
            });
          },
        };
      },
    },
  },
});
