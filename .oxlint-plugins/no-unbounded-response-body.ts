// Remote response bodies are read through a bounded reader.
//
// `Response.arrayBuffer()`, `.text()`, `.json()`, `.blob()`, and `.bytes()`
// buffer the whole body before returning, whatever its size. An upstream that
// answers with a very large (or endless) body therefore costs the API process
// that much memory before any code can refuse it. The owned readers stop at a
// byte ceiling instead:
//
//   - outbound HTTP: `safeOutboundFetchBytes` / `safeOutboundFetchStream`
//     (`@/api/lib/safe-outbound-fetch`), or `readCappedBytes`
//     (`@stll/skills/streaming`) over `response.body`;
//   - object storage: `readS3ObjectBounded`, `readCorpusS3BytesBounded`, and
//     `readCorpusS3ObjectBounded` (`@/api/lib/s3`).
//
// Detection is syntactic. A receiver counts as a fetch `Response` when it is
//
//   - a call to `fetch`, to any `<object>.fetch` (`globalThis.fetch`, an
//     injected `deps.fetch`), or to the shared Response-returning wrappers
//     `fetchWithTimeout`, `fetchPublisher`, and `fetchWithRetry`;
//   - a call to a function declared in the same file whose return type is
//     annotated `Response` or `Promise<Response>`;
//   - a parameter or binding annotated `Response` (optionally `| null` or
//     `| undefined`);
//   - any of the above behind `await`, `.clone()`, a `const` (or a
//     never-reassigned `let`) bound to one, or an element of
//     `const [a, b] = await Promise.all([...])`. Bindings are resolved through
//     scope analysis, so a shadowing parameter does not inherit provenance.
//
// Object storage is covered by name: a call to one of the unbounded readers
// exported by `@/api/lib/s3` (`readS3ArrayBuffer`, `readCorpusS3Bytes`,
// `getS3ObjectWithSignal`, `readS3ObjectIfPresent`) imported from that module,
// and `.transformToByteArray()` / `.transformToString()` on an AWS SDK
// `<output>.Body`. Native Bun S3 handles are confined by
// `no-native-s3-object-read`.
//
// Not reported: `Request` bodies and Elysia `t.File()` uploads (bounded by the
// route schema's `maxSize`), `Bun.file(...)` reads, `new Response(stream)`
// wrappers around local subprocess output, and any receiver whose provenance
// is not visible in the file. The modules that implement the bounded readers
// are excluded in `oxlint.config.ts`.
//
// Known blind spots: fetch functions passed in under another name
// (`fetchImpl(...)`, `dependencies.request(...)`), Response-returning helpers
// imported from another module without being one of the wrappers above,
// unannotated callback parameters (`parseResponse: async (response) => ...`),
// and responses unwrapped from a `Result` (`responseResult.value.json()`).
// Reading a `Response` this process built itself is bounded by construction
// but is reported when it arrives through a `Response`-typed parameter.

import { eslintCompatPlugin } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

import {
  type AstNode,
  getImportedName,
  getImportLocalName,
  getPropertyName,
  isAstNode,
  isIdentifier,
  isMemberAccess,
  unwrapExpression,
} from "./utils.ts";

const BODY_READS: ReadonlySet<string> = new Set([
  "arrayBuffer",
  "blob",
  "bytes",
  "json",
  "text",
]);

const FETCH_FUNCTIONS: ReadonlySet<string> = new Set([
  "fetch",
  "fetchPublisher",
  "fetchWithRetry",
  "fetchWithTimeout",
]);

const S3_MODULE = "@/api/lib/s3";

const UNBOUNDED_S3_READERS: ReadonlySet<string> = new Set([
  "getS3ObjectWithSignal",
  "readCorpusS3Bytes",
  "readS3ArrayBuffer",
  "readS3ObjectIfPresent",
]);

const SDK_BODY_READS: ReadonlySet<string> = new Set([
  "transformToByteArray",
  "transformToString",
]);

const isIdentifierReference = (
  node: unknown,
): node is ESTree.IdentifierReference =>
  isIdentifier(node) && Array.isArray(node.range);

const memberName = (member: AstNode): string | null => {
  if (member.computed === true) {
    return isAstNode(member.property) &&
      member.property.type === "Literal" &&
      typeof member.property.value === "string"
      ? member.property.value
      : null;
  }
  return getPropertyName(member.property);
};

const calledMember = (node: unknown): AstNode | null => {
  if (!isAstNode(node) || node.type !== "CallExpression") {
    return null;
  }
  const callee = unwrapExpression(node.callee);
  return callee?.type === "MemberExpression" ? callee : null;
};

const NULLISH_TYPES: ReadonlySet<string> = new Set([
  "TSNullKeyword",
  "TSUndefinedKeyword",
]);

// `Response`, optionally in a union with `null`/`undefined`.
const isResponseType = (type: unknown): boolean => {
  if (!isAstNode(type)) {
    return false;
  }
  if (type.type === "TSTypeReference") {
    return isIdentifier(type.typeName, "Response");
  }
  if (type.type !== "TSUnionType" || !Array.isArray(type.types)) {
    return false;
  }
  const members = type.types.filter(isAstNode);
  return (
    members.some(isResponseType) &&
    members.every(
      (member) => isResponseType(member) || NULLISH_TYPES.has(member.type),
    )
  );
};

// The type written in a `: T` annotation node.
const annotatedType = (annotation: unknown): unknown =>
  isAstNode(annotation) ? annotation.typeAnnotation : null;

// A return type of `Response` or `Promise<Response>` (nullable either way).
const isResponseReturnType = (annotation: unknown): boolean => {
  const type = annotatedType(annotation);
  if (isResponseType(type)) {
    return true;
  }
  if (
    !isAstNode(type) ||
    type.type !== "TSTypeReference" ||
    !isIdentifier(type.typeName, "Promise")
  ) {
    return false;
  }
  const typeArguments = type.typeArguments;
  const params =
    isAstNode(typeArguments) && Array.isArray(typeArguments.params)
      ? typeArguments.params
      : [];
  return params.length === 1 && isResponseType(params.at(0));
};

export default eslintCompatPlugin({
  meta: { name: "no-unbounded-response-body" },
  rules: {
    "no-unbounded-response-body": {
      meta: {
        type: "problem",
        messages: {
          fetchBody:
            "`.{{method}}()` buffers the whole fetch response with no size " +
            "limit. Read it with a byte ceiling: safeOutboundFetchBytes / " +
            "safeOutboundFetchStream (@/api/lib/safe-outbound-fetch), or " +
            "readCappedBytes (@stll/skills/streaming) over response.body.",
          s3Reader:
            "`{{method}}` reads the whole object with no size limit. Use " +
            "readS3ObjectBounded, readCorpusS3BytesBounded, or " +
            "readCorpusS3ObjectBounded from @/api/lib/s3 with a maxBytes.",
          sdkBody:
            "`.{{method}}()` buffers the whole S3 object body with no size " +
            "limit. Read objects through the bounded readers in @/api/lib/s3 " +
            "(readS3ObjectBounded, readCorpusS3ObjectBounded).",
        },
      },
      createOnce(context) {
        // Local names of the unbounded S3 readers imported in this file.
        let s3ReaderLocals = new Map<string, string>();

        const resolveVariable = (identifier: ESTree.IdentifierReference) => {
          let scope: ReturnType<typeof context.sourceCode.getScope> | null =
            context.sourceCode.getScope(identifier);
          while (scope) {
            const variable = scope.set.get(identifier.name);
            if (variable) {
              return variable;
            }
            scope = scope.upper;
          }
          return null;
        };

        // `const [a, b] = await Promise.all([x, y])` binds `b` to `y`.
        const promiseAllElement = (def, name: string): unknown => {
          if (
            def.type !== "Variable" ||
            !isAstNode(def.node) ||
            !isAstNode(def.node.id) ||
            def.node.id.type !== "ArrayPattern" ||
            !Array.isArray(def.node.id.elements)
          ) {
            return null;
          }
          const index = def.node.id.elements.findIndex((element) =>
            isIdentifier(element, name),
          );
          let init = unwrapExpression(def.node.init);
          if (init?.type === "AwaitExpression") {
            init = unwrapExpression(init.argument);
          }
          if (
            index === -1 ||
            init?.type !== "CallExpression" ||
            !isMemberAccess(init.callee, "Promise", "all")
          ) {
            return null;
          }
          const list = unwrapExpression(
            Array.isArray(init.arguments) ? init.arguments.at(0) : null,
          );
          return list?.type === "ArrayExpression" &&
            Array.isArray(list.elements)
            ? list.elements.at(index)
            : null;
        };

        // The initializer of a binding that still denotes it: `const`, or a
        // `let`/`var` that scope analysis proves is never written after init.
        const stableInitializer = (variable): unknown => {
          const reassigned = variable.references.some(
            (reference) =>
              typeof reference.isWrite === "function" &&
              reference.isWrite() &&
              reference.init !== true,
          );
          for (const def of variable.defs) {
            // A `let`/`var` written after its declaration no longer denotes
            // its initializer, destructured or not.
            if (
              reassigned &&
              isAstNode(def.parent) &&
              def.parent.type === "VariableDeclaration" &&
              def.parent.kind !== "const"
            ) {
              return null;
            }
            const destructured = promiseAllElement(def, variable.name);
            if (destructured !== null) {
              return destructured;
            }
            if (
              def.type !== "Variable" ||
              !isAstNode(def.node) ||
              def.node.type !== "VariableDeclarator" ||
              !isAstNode(def.parent) ||
              def.parent.type !== "VariableDeclaration"
            ) {
              continue;
            }
            return def.node.init;
          }
          return null;
        };

        // A same-file function whose declared return type is a Response.
        const returnsResponse = (callee: ESTree.IdentifierReference) => {
          const variable = resolveVariable(callee);
          if (variable === null) {
            return false;
          }
          for (const def of variable.defs) {
            if (def.type === "FunctionName") {
              const declaration: unknown = def.node;
              return (
                isAstNode(declaration) &&
                isResponseReturnType(declaration.returnType)
              );
            }
            if (def.type === "Variable" && isAstNode(def.node)) {
              const init = unwrapExpression(def.node.init);
              if (
                init?.type === "ArrowFunctionExpression" ||
                init?.type === "FunctionExpression"
              ) {
                return isResponseReturnType(init.returnType);
              }
            }
          }
          return false;
        };

        // A parameter or binding written with a `Response` type annotation.
        const isDeclaredResponse = (variable): boolean =>
          variable.defs.some((def) => {
            if (def.type === "Parameter") {
              return (
                isAstNode(def.name) &&
                isResponseType(annotatedType(def.name.typeAnnotation))
              );
            }
            return (
              def.type === "Variable" &&
              isAstNode(def.node) &&
              isAstNode(def.node.id) &&
              isResponseType(annotatedType(def.node.id.typeAnnotation))
            );
          });

        const isFetchCall = (node: AstNode): boolean => {
          const callee = unwrapExpression(node.callee);
          if (callee === null) {
            return false;
          }
          if (isIdentifierReference(callee)) {
            return FETCH_FUNCTIONS.has(callee.name) || returnsResponse(callee);
          }
          return (
            callee.type === "MemberExpression" && memberName(callee) === "fetch"
          );
        };

        const isFetchResponse = (
          node: unknown,
          visited: Set<unknown>,
        ): boolean => {
          const current = unwrapExpression(node);
          if (current === null || visited.has(current)) {
            return false;
          }
          visited.add(current);
          if (current.type === "AwaitExpression") {
            return isFetchResponse(current.argument, visited);
          }
          if (current.type === "CallExpression") {
            const member = calledMember(current);
            if (member !== null && memberName(member) === "clone") {
              return isFetchResponse(member.object, visited);
            }
            return isFetchCall(current);
          }
          if (!isIdentifierReference(current)) {
            return false;
          }
          const variable = resolveVariable(current);
          if (variable === null) {
            return false;
          }
          if (isDeclaredResponse(variable)) {
            return true;
          }
          return isFetchResponse(stableInitializer(variable), visited);
        };

        return {
          before() {
            s3ReaderLocals = new Map();
          },
          ImportDeclaration(node) {
            if (node.source.value !== S3_MODULE) {
              return;
            }
            for (const specifier of node.specifiers) {
              const imported = getImportedName(specifier);
              const local = getImportLocalName(specifier);
              if (
                imported !== null &&
                local !== null &&
                UNBOUNDED_S3_READERS.has(imported)
              ) {
                s3ReaderLocals.set(local, imported);
              }
            }
          },
          CallExpression(node) {
            const callee = unwrapExpression(node.callee);
            if (callee === null) {
              return;
            }
            if (isIdentifierReference(callee)) {
              const imported = s3ReaderLocals.get(callee.name);
              // Scope check: a local that shadows the import is not the reader.
              const variable =
                imported === undefined ? null : resolveVariable(callee);
              if (
                imported !== undefined &&
                variable?.defs.some((def) => def.type === "ImportBinding")
              ) {
                context.report({
                  node,
                  messageId: "s3Reader",
                  data: { method: imported },
                });
              }
              return;
            }
            if (callee.type !== "MemberExpression") {
              return;
            }
            const method = memberName(callee);
            if (method === null) {
              return;
            }
            if (SDK_BODY_READS.has(method)) {
              const receiver = unwrapExpression(callee.object);
              if (
                receiver?.type === "MemberExpression" &&
                memberName(receiver) === "Body"
              ) {
                context.report({
                  node,
                  messageId: "sdkBody",
                  data: { method },
                });
              }
              return;
            }
            if (
              BODY_READS.has(method) &&
              isFetchResponse(callee.object, new Set())
            ) {
              context.report({
                node,
                messageId: "fetchBody",
                data: { method },
              });
            }
          },
        };
      },
    },
  },
});
