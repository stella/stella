// Require a `message: string` field on better-result TaggedError classes.
//
// AGENTS.md mandates: "Every TaggedError must include a `message: string`
// field." Without it, toast, reporting, and serialize paths have no
// human-readable text to surface. This rule flags a class extending the
// `TaggedError("Name")<{...}>()` factory whose inline type-argument literal
// omits a `message` key.
//
// Only the inline `TSTypeLiteral` form is checked; named-alias props (e.g.
// `TaggedError("X")<XProps>()`) are skipped, since the alias is defined
// elsewhere and resolving it would need type information the linter lacks.
//
// Flagged:
//   class DataError extends TaggedError("DataError")<{
//     id: string;
//   }>() {}
//
// Allowed:
//   class DataError extends TaggedError("DataError")<{
//     id: string; message: string;
//   }>() {}
//   class HandlerError extends TaggedError("HandlerError")<HandlerProps>() {}
//
// The `message` member must be present, non-optional, and typed `string`;
// `message?: string` or `message: <not string>` is flagged too.

export default {
  meta: { name: "tagged-error-requires-message" },
  rules: {
    "tagged-error-requires-message": {
      meta: {
        type: "problem",
        messages: {
          requiresMessage:
            "TaggedError subclasses must include a `message: string` " +
            "field in their type-argument literal. Without it, toast, " +
            "reporting, and serialize paths have no human-readable text.",
        },
      },
      create(context) {
        const checkClass = (node) => {
          // superClass is the outer `()` call: TaggedError("Name")<{...}>()
          const superClass = node.superClass;
          if (!superClass || superClass.type !== "CallExpression") {
            return;
          }

          // Its callee is the factory call TaggedError("Name"), itself a
          // CallExpression whose callee is the `TaggedError` Identifier.
          const factoryCall = superClass.callee;
          if (!factoryCall || factoryCall.type !== "CallExpression") {
            return;
          }
          const factoryCallee = factoryCall.callee;
          if (
            !factoryCallee ||
            factoryCallee.type !== "Identifier" ||
            factoryCallee.name !== "TaggedError"
          ) {
            return;
          }

          // The type arguments (<{...}>) hang off the OUTER call.
          const firstTypeArg = superClass.typeArguments?.params?.[0];
          // Only the inline object-literal form is checked; named aliases
          // (TSTypeReference) are resolved elsewhere and skipped to keep
          // false positives at zero.
          if (!firstTypeArg || firstTypeArg.type !== "TSTypeLiteral") {
            return;
          }

          // A bare member named `message` is not enough: it must be a
          // non-optional property typed with the `string` keyword. `message?:
          // string`, `message: unknown`, or a method signature would otherwise
          // satisfy the rule while leaving callers free to omit human-readable
          // text.
          const hasMessage = (firstTypeArg.members ?? []).some((member) => {
            if (member.type !== "TSPropertySignature" || member.optional) {
              return false;
            }
            const key = member.key;
            const isMessageKey =
              (key?.type === "Identifier" && key.name === "message") ||
              (key?.type === "Literal" && key.value === "message");
            if (!isMessageKey) {
              return false;
            }
            return (
              member.typeAnnotation?.typeAnnotation?.type === "TSStringKeyword"
            );
          });

          if (!hasMessage) {
            context.report({ node, messageId: "requiresMessage" });
          }
        };

        return {
          ClassDeclaration: checkClass,
          ClassExpression: checkClass,
        };
      },
    },
  },
};
