import { eslintCompatPlugin } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";
// Confine S3 object-body reads to the owned storage boundary.
//
// `apps/api/src/lib/s3.ts` owns cancellation, size, range, credential refresh,
// and response-validation requirements. A direct read elsewhere bypasses
// those decisions and shared error semantics. Bun 1.4 fixes the native
// reader's retained-buffer bug, but native body reads still have no deadline.

import { isAstNode, isIdentifier } from "./utils.ts";

// Body-materialising reads only. `.exists()`, `.stat()`, `.write()`,
// `.delete()`, and `.presign()` carry no response body and do not leak.
const BODY_READS = new Set(["arrayBuffer", "bytes", "text", "json"]);

// Accessors that hand back a Bun S3 client. A local `new Bun.S3Client(...)`
// is caught through the `.file(...)` receiver check below instead.
const S3_ACCESSORS = new Set(["getS3", "getCorpusS3"]);

const isIdentifierReference = (
  node: unknown,
): node is ESTree.IdentifierReference =>
  isIdentifier(node) && Array.isArray(node.range);

const isS3AccessorCall = (node) =>
  node?.type === "CallExpression" &&
  isIdentifier(node.callee) &&
  S3_ACCESSORS.has(node.callee.name);

/** True for `<something>.file(...)` — the call that yields the S3 file handle. */
const isFileCall = (node) =>
  node?.type === "CallExpression" &&
  node.callee.type === "MemberExpression" &&
  !node.callee.computed &&
  isIdentifier(node.callee.property, "file");

const bodyReadMethod = (member) => {
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

export default eslintCompatPlugin({
  meta: { name: "no-native-s3-object-read" },
  rules: {
    "no-native-s3-object-read": {
      meta: {
        type: "problem",
        messages: {
          noNativeS3ObjectRead:
            "Do not read an S3 object body with .{{method}}() outside the " +
            "owned storage boundary. Use the appropriate read helper from " +
            "@/api/lib/s3 so cancellation, bounds, credentials, and errors " +
            "remain consistent.",
        },
      },
      createOnce(context) {
        const isS3ClientConstruction = (init) =>
          init?.type === "NewExpression" &&
          ((isIdentifier(init.callee) && init.callee.name === "S3Client") ||
            (init.callee.type === "MemberExpression" &&
              !init.callee.computed &&
              isIdentifier(init.callee.property, "S3Client")));

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

        // Return the initializer only while the identifier still denotes that
        // binding. Binding identity prevents a same-named parameter or nested
        // local from inheriting provenance. Mutable bindings are accepted only
        // when scope analysis proves they were never reassigned after init.
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

        const isS3ClientExpression = (
          node,
          visited = new Set<unknown>(),
        ): boolean => {
          if (isS3AccessorCall(node) || isS3ClientConstruction(node)) {
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
          return isS3ClientExpression(getStableInitializer(variable), visited);
        };

        const isS3FileExpression = (
          node,
          visited = new Set<unknown>(),
        ): boolean => {
          if (isFileCall(node)) {
            return isS3ClientExpression(node.callee.object, visited);
          }
          if (!isIdentifierReference(node)) {
            return false;
          }
          const variable = resolveVariable(node);
          if (variable === null || visited.has(variable)) {
            return false;
          }
          visited.add(variable);
          return isS3FileExpression(getStableInitializer(variable), visited);
        };

        return {
          CallExpression(node) {
            const callee = node.callee;
            if (callee.type !== "MemberExpression") {
              return;
            }
            const method = bodyReadMethod(callee);
            if (!method || !BODY_READS.has(method)) {
              return;
            }

            if (!isS3FileExpression(callee.object)) {
              return;
            }

            context.report({
              node,
              messageId: "noNativeS3ObjectRead",
              data: { method },
            });
          },
        };
      },
    },
  },
});
