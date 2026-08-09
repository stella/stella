// Prevent raw JSON from being asserted or annotated as a closed domain type.
//
// Third-party APIs and durable JSON can add fields without breaking callers;
// raw passthrough remains valid as `unknown` or `JsonValue`. What is unsafe is
// claiming that `response.json()` / `JSON.parse()` already satisfies a richer
// project type before a runtime parser has checked the fields the project uses.
//
// Flags in production application/package source:
//   (await response.json()) as RegistryCompany
//   response.json<RegistryCompany>()
//   JSON.parse(raw) as DocumentAst
//   const payload: RegistryCompany = JSON.parse(raw)
//
// Allows:
//   const payload: unknown = await response.json()
//   const payload: JsonValue = JSON.parse(raw)
//   v.parse(schema, await response.json())
//   v.safeParse(openSchema, JSON.parse(raw))

import {
  filenameForContext,
  getPropertyName,
  isAstNode,
  isIdentifier,
  unwrapExpression,
} from "./utils.ts";

const isProductionBoundaryFile = (filename: string): boolean => {
  if (filename.includes("/.oxlint-plugins/__fixtures__/")) {
    return true;
  }
  if (!filename.includes("/apps/") && !filename.includes("/packages/")) {
    return false;
  }
  return !(
    filename.includes("/e2e/") ||
    filename.includes("/scripts/") ||
    filename.includes("/packages/scripts/") ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(filename)
  );
};

const peelRuntimeExpression = (node: unknown) => {
  let current = unwrapExpression(node);
  while (
    current?.type === "AwaitExpression" ||
    current?.type === "ParenthesizedExpression" ||
    current?.type === "TSNonNullExpression"
  ) {
    current = unwrapExpression(current.argument ?? current.expression);
  }
  return current;
};

const isJsonParseMember = (node: unknown): boolean => {
  const current = peelRuntimeExpression(node);
  if (current?.type !== "MemberExpression") {
    return false;
  }
  const object = peelRuntimeExpression(current.object);
  const isJsonObject =
    isIdentifier(object, "JSON") ||
    (object?.type === "MemberExpression" &&
      getPropertyName(object.property) === "JSON" &&
      isIdentifier(peelRuntimeExpression(object.object), "globalThis"));
  return isJsonObject && getPropertyName(current.property) === "parse";
};

const isJsonParseCall = (
  node: unknown,
  jsonParseAliases: ReadonlySet<string>,
): boolean => {
  const current = peelRuntimeExpression(node);
  if (current?.type !== "CallExpression") {
    return false;
  }
  const callee = peelRuntimeExpression(current.callee);
  return (
    isJsonParseMember(callee) ||
    (callee?.type === "Identifier" && jsonParseAliases.has(callee.name))
  );
};

const isResponseJsonCall = (node: unknown): boolean => {
  const current = peelRuntimeExpression(node);
  if (current?.type !== "CallExpression") {
    return false;
  }
  const callee = peelRuntimeExpression(current.callee);
  return (
    callee?.type === "MemberExpression" &&
    getPropertyName(callee.property) === "json"
  );
};

const unwrapTypeAnnotation = (node: unknown) => {
  if (!isAstNode(node)) {
    return null;
  }
  if (node.type === "TSTypeAnnotation") {
    return unwrapTypeAnnotation(node.typeAnnotation);
  }
  if (node.type === "TSParenthesizedType" || node.type === "TSOptionalType") {
    return unwrapTypeAnnotation(node.typeAnnotation);
  }
  return node;
};

const isRawJsonType = (node: unknown): boolean => {
  const typeNode = unwrapTypeAnnotation(node);
  if (typeNode?.type === "TSUnknownKeyword") {
    return true;
  }
  return (
    typeNode?.type === "TSTypeReference" &&
    (isIdentifier(typeNode.typeName, "JsonValue") ||
      isIdentifier(typeNode.typeName, "ReadonlyJsonValue"))
  );
};

export default {
  meta: { name: "no-unvalidated-json-domain-cast" },
  rules: {
    "no-unvalidated-json-domain-cast": {
      meta: {
        type: "problem",
        messages: {
          unvalidatedDomain:
            "Raw JSON is not a validated domain value. Keep it as `unknown`/`JsonValue`, then parse only the consumed fields with a runtime schema (use a loose/open schema for evolving upstream payloads).",
        },
      },
      create(context) {
        if (!isProductionBoundaryFile(filenameForContext(context))) {
          return {};
        }

        const jsonParseAliases = new Set<string>();
        const isRawJsonBoundary = (node: unknown): boolean =>
          isJsonParseCall(node, jsonParseAliases) || isResponseJsonCall(node);

        const checkAssertion = (node) => {
          if (
            isRawJsonBoundary(node.expression) &&
            !isRawJsonType(node.typeAnnotation)
          ) {
            context.report({ node, messageId: "unvalidatedDomain" });
          }
        };

        return {
          CallExpression(node) {
            const typeArgument = node.typeArguments?.params?.at(0);
            if (
              typeArgument &&
              isRawJsonBoundary(node) &&
              !isRawJsonType(typeArgument)
            ) {
              context.report({ node, messageId: "unvalidatedDomain" });
            }
          },
          VariableDeclarator(node) {
            if (
              node.id?.type === "Identifier" &&
              isJsonParseMember(node.init)
            ) {
              jsonParseAliases.add(node.id.name);
            }
            if (
              isRawJsonBoundary(node.init) &&
              node.id?.typeAnnotation &&
              !isRawJsonType(node.id.typeAnnotation)
            ) {
              context.report({ node, messageId: "unvalidatedDomain" });
            }
          },
          TSAsExpression: checkAssertion,
          TSTypeAssertion: checkAssertion,
        };
      },
    },
  },
};
