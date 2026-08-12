import { eslintCompatPlugin } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

import { isAstNode, isIdentifier } from "./utils.ts";

// A write that times out can still finish at S3 after the caller has moved
// on. `writeS3ObjectWithRetry` retries that ambiguous failure at the same key,
// so record-identity/content-addressed keys converge rather than leaking a
// newly generated object for every attempt. Keep native Bun writes behind that
// boundary. The two lower-level modules are deliberately excluded in
// oxlint.config.ts: they own abortable writes and tenant-scoped AWS SDK writes.

const isIdentifierReference = (
  node: unknown,
): node is ESTree.IdentifierReference =>
  isIdentifier(node) && Array.isArray(node.range);

const propertyName = (member: ESTree.MemberExpression): string | null => {
  if (!member.computed && isIdentifier(member.property)) {
    return member.property.name;
  }
  if (
    member.computed &&
    member.property.type === "Literal" &&
    typeof member.property.value === "string"
  ) {
    return member.property.value;
  }
  return null;
};

const isGetS3Call = (node: unknown): boolean =>
  isAstNode(node) &&
  node.type === "CallExpression" &&
  isIdentifier(node.callee, "getS3");

const isS3ClientConstruction = (node: unknown): boolean => {
  if (!isAstNode(node) || node.type !== "NewExpression") {
    return false;
  }
  const callee = node.callee;
  return (
    (isIdentifier(callee) && callee.name === "S3Client") ||
    (isAstNode(callee) &&
      callee.type === "MemberExpression" &&
      callee.computed === false &&
      isIdentifier(callee.property, "S3Client"))
  );
};

export default eslintCompatPlugin({
  meta: { name: "no-native-s3-object-write" },
  rules: {
    "no-native-s3-object-write": {
      meta: {
        type: "problem",
        messages: {
          noNativeS3ObjectWrite:
            "Do not write a documents-bucket object with native S3 I/O; use " +
            "writeS3ObjectWithRetry() so bounded retries converge at the " +
            "same deterministic key. Abortable and tenant-scoped primitives " +
            "belong only in @/api/lib/s3 or @/api/lib/s3-presign.",
        },
      },
      createOnce(context) {
        const resolveVariable = (
          identifierNode: ESTree.IdentifierReference,
        ) => {
          let scope: ReturnType<typeof context.sourceCode.getScope> | null =
            context.sourceCode.getScope(identifierNode);
          while (scope) {
            const variable = scope.set.get(identifierNode.name);
            if (variable) {
              return variable;
            }
            scope = scope.upper;
          }
          return null;
        };

        const getStableInitializer = (variable) => {
          for (const def of variable.defs) {
            if (
              def.type !== "Variable" ||
              !isAstNode(def.node) ||
              def.node.type !== "VariableDeclarator" ||
              !isAstNode(def.parent) ||
              def.parent.type !== "VariableDeclaration"
            ) {
              continue;
            }
            if (
              def.parent.kind !== "const" &&
              variable.references.some(
                (reference) =>
                  typeof reference.isWrite === "function" &&
                  reference.isWrite() &&
                  reference.init !== true,
              )
            ) {
              return null;
            }
            return isAstNode(def.node.init) ? def.node.init : null;
          }
          return null;
        };

        const isDocumentsS3Client = (
          node: unknown,
          visited = new Set<unknown>(),
        ): boolean => {
          if (isGetS3Call(node) || isS3ClientConstruction(node)) {
            return true;
          }
          if (!isIdentifierReference(node)) {
            return false;
          }
          const variable = resolveVariable(node);
          if (variable === null || visited.has(variable)) {
            return false;
          }
          visited.add(variable);
          return isDocumentsS3Client(getStableInitializer(variable), visited);
        };

        const isPutObjectCommand = (
          node: unknown,
          visited = new Set<unknown>(),
        ): boolean => {
          if (isAstNode(node) && node.type === "NewExpression") {
            const callee = node.callee;
            if (
              (isIdentifier(callee) && callee.name === "PutObjectCommand") ||
              (isAstNode(callee) &&
                callee.type === "MemberExpression" &&
                callee.computed === false &&
                isIdentifier(callee.property, "PutObjectCommand"))
            ) {
              return true;
            }
          }
          if (!isIdentifierReference(node)) {
            return false;
          }
          const variable = resolveVariable(node);
          if (variable === null || visited.has(variable)) {
            return false;
          }
          visited.add(variable);
          return isPutObjectCommand(getStableInitializer(variable), visited);
        };

        return {
          CallExpression(node) {
            if (node.callee.type !== "MemberExpression") {
              return;
            }
            const method = propertyName(node.callee);
            if (
              (method === "write" && isDocumentsS3Client(node.callee.object)) ||
              (method === "send" && isPutObjectCommand(node.arguments.at(0)))
            ) {
              context.report({ node, messageId: "noNativeS3ObjectWrite" });
            }
          },
        };
      },
    },
  },
});
