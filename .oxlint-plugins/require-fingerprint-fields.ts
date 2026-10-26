// Require local TaggedError reason/phase/stage fields to opt into fingerprinting.
// Inline props are checked syntactically; named props and inherited classes are
// outside this detector. TypeScript checks that registered fields are finite.
// Flagged: class E extends TaggedError("E")<{reason: "read"; message: string}> {}
// Accepted: the same class with static { declareFingerprintFields(this, ["reason"]); }
import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  getPropertyName,
  isAstNode,
  isIdentifier,
  isStringLiteral,
} from "./utils.ts";
import type { AstNode } from "./utils.ts";

const RULE_NAME = "require-fingerprint-fields";
const DIMENSIONS = new Set(["reason", "phase", "stage"]);

const registeredFields = (
  node: AstNode,
  declarationName: string,
): Set<string> => {
  const fields = new Set<string>();
  if (!isAstNode(node.body) || !Array.isArray(node.body.body)) {
    return fields;
  }
  for (const block of node.body.body) {
    if (
      !isAstNode(block) ||
      block.type !== "StaticBlock" ||
      !Array.isArray(block.body)
    ) {
      continue;
    }
    for (const statement of block.body) {
      if (!isAstNode(statement) || statement.type !== "ExpressionStatement") {
        continue;
      }
      const call = statement.expression;
      if (
        !isAstNode(call) ||
        call.type !== "CallExpression" ||
        !isIdentifier(call.callee, declarationName) ||
        !Array.isArray(call.arguments)
      ) {
        continue;
      }
      const target = call.arguments.at(0);
      const dimensions = call.arguments.at(1);
      if (
        !isAstNode(target) ||
        target.type !== "ThisExpression" ||
        !isAstNode(dimensions) ||
        dimensions.type !== "ArrayExpression" ||
        !Array.isArray(dimensions.elements)
      ) {
        continue;
      }
      for (const field of dimensions.elements) {
        if (isStringLiteral(field)) {
          fields.add(field.value);
        }
      }
    }
  }
  return fields;
};

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        messages: {
          missing:
            "Register every typed reason, phase and stage with declareFingerprintFields(this, [...]) in a static block so new causes cannot silently merge into an existing issue.",
        },
      },
      createOnce(context) {
        let factoryName = "TaggedError";
        let declarationName = "";
        const checkClass = (node: unknown) => {
          if (
            !isAstNode(node) ||
            !isAstNode(node.superClass) ||
            node.superClass.type !== "CallExpression" ||
            !isIdentifier(node.superClass.callee, factoryName)
          ) {
            return;
          }
          const args = node.superTypeArguments;
          const props =
            isAstNode(args) && Array.isArray(args.params)
              ? args.params.at(0)
              : undefined;
          if (
            !isAstNode(props) ||
            props.type !== "TSTypeLiteral" ||
            !Array.isArray(props.members)
          ) {
            return;
          }
          const registered = registeredFields(node, declarationName);
          for (const member of props.members) {
            if (!isAstNode(member) || member.type !== "TSPropertySignature") {
              continue;
            }
            const name = getPropertyName(member.key);
            if (name === null || !DIMENSIONS.has(name)) {
              continue;
            }
            const annotation = member.typeAnnotation;
            const type = isAstNode(annotation)
              ? annotation.typeAnnotation
              : undefined;
            if (isAstNode(type) && type.type === "TSStringKeyword") {
              continue;
            }
            if (
              ![...registered].some(
                (field) => field === name || field.startsWith(`${name}.`),
              )
            ) {
              context.report({ node: member, messageId: "missing" });
            }
          }
        };
        return {
          Program() {
            factoryName = "TaggedError";
            declarationName = "";
          },
          ImportDeclaration(node) {
            if (
              !isStringLiteral(node.source) ||
              !Array.isArray(node.specifiers)
            ) {
              return;
            }
            for (const specifier of node.specifiers) {
              if (
                !isAstNode(specifier) ||
                specifier.type !== "ImportSpecifier" ||
                !isIdentifier(specifier.local)
              ) {
                continue;
              }
              if (
                node.source.value === "better-result" &&
                isIdentifier(specifier.imported, "TaggedError")
              ) {
                factoryName = specifier.local.name;
              }
              if (
                node.source.value === "@stll/errors" &&
                isIdentifier(specifier.imported, "declareFingerprintFields")
              ) {
                declarationName = specifier.local.name;
              }
            }
          },
          ClassDeclaration: checkClass,
          ClassExpression: checkClass,
        };
      },
    },
  },
});
