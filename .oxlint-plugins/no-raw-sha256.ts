import { type ESTree, eslintCompatPlugin } from "@oxlint/plugins";

import { SHA256_OWNERS } from "../scripts/sha256-owners.ts";
import {
  type ScopeContext,
  isAstNode,
  isIdentifier,
  isIdentifierReference,
  isSingleAssignment,
  memberPropertyName,
  patternKeyFor,
  repoRelativeFilename,
  resolveImportedExpression,
  resolveVariable,
  staticStringValue,
  stableInitializer,
  unwrapExpression,
} from "./utils.ts";

const importedPrimitivePath = (
  context: ScopeContext,
  node: unknown,
): string | null => {
  const imported = resolveImportedExpression(context, node);
  if (imported?.source === "node:crypto" || imported?.source === "crypto") {
    if (imported.imported === "createHash") {
      return "createHash";
    }
    if (imported.imported === "webcrypto") {
      return "crypto";
    }
    if (imported.imported === "default" || imported.imported === "*") {
      return "nodeCrypto";
    }
  }
  if (imported?.source === "bun") {
    if (imported.imported === "default" || imported.imported === "*") {
      return "Bun";
    }
    if (imported.imported === "CryptoHasher") {
      return "Bun.CryptoHasher";
    }
    if (imported.imported === "SHA256") {
      return "Bun.SHA256";
    }
  }
  return null;
};

// Resolve immutable aliases for call classification. Escaped primitive values
// are rejected at acquisition; runtime-computed keys remain a syntax boundary.
const primitivePath = (
  context: ScopeContext,
  value: unknown,
  seen = new Set<unknown>(),
): string | null => {
  const node = unwrapExpression(value);
  if (!isAstNode(node) || seen.has(node)) {
    return null;
  }
  seen.add(node);
  const imported = importedPrimitivePath(context, node);
  if (imported !== null) {
    return imported;
  }
  if (node.type === "MemberExpression") {
    const base = primitivePath(context, node.object, seen);
    const key = memberPropertyName(node);
    return base !== null && key !== null ? `${base}.${key}` : null;
  }
  if (!isIdentifierReference(node)) {
    return null;
  }
  const variable = resolveVariable(context, node);
  if (variable === null || variable.defs.length === 0) {
    if (["window", "globalThis", "self"].includes(node.name)) {
      return "";
    }
    return node.name === "crypto" || node.name === "Bun" ? node.name : null;
  }
  const definition = variable.defs.at(0);
  if (variable.defs.length !== 1 || !isSingleAssignment(variable)) {
    return null;
  }
  const declaration: unknown = definition?.node;
  if (!isAstNode(declaration) || declaration.type !== "VariableDeclarator") {
    return null;
  }
  const base = primitivePath(context, declaration.init, seen);
  if (base === null) {
    return null;
  }
  if (isIdentifier(declaration.id)) {
    return base;
  }
  if (!isAstNode(declaration.id) || declaration.id.type !== "ObjectPattern") {
    return null;
  }
  const key = patternKeyFor(declaration.id, definition?.name);
  return key === null ? null : `${base}.${key}`;
};

const normalizedPath = (value: string | null) =>
  value
    ?.replace(/^\./u, "")
    .replace(/^nodeCrypto\.webcrypto/u, "crypto")
    .replace(/^nodeCrypto\.createHash$/u, "createHash") ?? null;

const algorithmName = (
  context: ScopeContext,
  value: unknown,
  seen = new Set<unknown>(),
): string | null => {
  const node = unwrapExpression(value);
  if (!isAstNode(node) || seen.has(node)) {
    return null;
  }
  seen.add(node);
  const literal = staticStringValue(node);
  if (literal !== null) {
    return literal;
  }
  if (node.type === "ObjectExpression" && Array.isArray(node.properties)) {
    for (const property of node.properties.toReversed()) {
      if (!isAstNode(property) || property.type === "SpreadElement") {
        return null;
      }
      const key =
        property.computed === true
          ? staticStringValue(property.key)
          : isIdentifier(property.key)
            ? property.key.name
            : staticStringValue(property.key);
      if (key === "name") {
        return algorithmName(context, property.value, seen);
      }
    }
    return null;
  }
  if (!isIdentifierReference(node)) {
    return null;
  }
  const variable = resolveVariable(context, node);
  return variable === null
    ? null
    : algorithmName(context, stableInitializer(variable), seen);
};

const isPrimitive = (value: string | null) =>
  value === "createHash" ||
  value === "Bun.CryptoHasher" ||
  value === "Bun.SHA256" ||
  value === "Bun.SHA256.hash" ||
  value === "crypto.subtle.digest";
type RawMemberAccessOptions = {
  primitive: string | null;
  property: string | null;
};
const isRawMemberAccess = ({ primitive, property }: RawMemberAccessOptions) =>
  isPrimitive(primitive) &&
  !(primitive === "Bun.SHA256" && property === "hash");

const isAbsentKey = (
  context: ScopeContext,
  value: unknown,
  seen = new Set<unknown>(),
): boolean => {
  if (value === undefined) {
    return true;
  }
  const key = unwrapExpression(value);
  if (!isAstNode(key) || seen.has(key)) {
    return false;
  }
  seen.add(key);
  if (key.type === "UnaryExpression" && key.operator === "void") {
    return true;
  }
  if (!isIdentifierReference(key)) {
    return false;
  }
  const variable = resolveVariable(context, key);
  if (variable === null || variable.defs.length === 0) {
    return key.name === "undefined";
  }
  const initializer = stableInitializer(variable);
  return initializer !== null && isAbsentKey(context, initializer, seen);
};

const isExemptFile = (filename: string, options: unknown) => {
  if (Object.keys(SHA256_OWNERS).some((owner) => filename === owner)) {
    return true;
  }
  if (typeof options !== "object" || options === null) {
    return false;
  }
  const files: unknown = Reflect.get(options, "allowedFiles");
  return (
    Array.isArray(files) &&
    files.some((file: unknown) => typeof file === "string" && filename === file)
  );
};

export default eslintCompatPlugin({
  meta: { name: "no-raw-sha256" },
  rules: {
    "no-raw-sha256": {
      meta: {
        type: "problem",
        schema: [
          {
            type: "object",
            properties: {
              allowedFiles: { type: "array", items: { type: "string" } },
            },
            additionalProperties: false,
          },
        ],
        messages: {
          owned:
            "Use the SHA-256 owner for this runtime; raw SHA-256 primitives are confined to the registered owners.",
        },
      },
      createOnce(context) {
        const isExempt = () =>
          isExemptFile(repoRelativeFilename(context), context.options.at(0));
        const escaped = (
          node: ESTree.IdentifierReference | ESTree.MemberExpression,
        ) => {
          if (isExempt() || !isAstNode(node)) {
            return;
          }
          let parent: unknown = node.parent;
          while (isAstNode(parent) && unwrapExpression(parent) === node) {
            parent = parent.parent;
          }
          if (
            !isAstNode(parent) ||
            parent.type === "ExportSpecifier" ||
            parent.type.startsWith("TS")
          ) {
            return;
          }
          if (
            parent.type === "Property" &&
            isAstNode(parent.parent) &&
            parent.parent.type === "ObjectPattern"
          ) {
            return;
          }
          if (
            (parent.type === "CallExpression" ||
              parent.type === "NewExpression") &&
            unwrapExpression(parent.callee) === node
          ) {
            return;
          }
          if (parent.type === "MemberExpression") {
            const path = normalizedPath(primitivePath(context, node));
            if (
              unwrapExpression(parent.object) === node &&
              isRawMemberAccess({
                primitive: path,
                property: memberPropertyName(parent),
              })
            ) {
              context.report({ node, messageId: "owned" });
            }
            return;
          }
          if (parent.type.startsWith("Import")) {
            return;
          }
          if (parent.type === "VariableDeclarator" && parent.id === node) {
            return;
          }
          if (
            parent.type === "Property" &&
            parent.key === node &&
            parent.shorthand !== true
          ) {
            return;
          }
          const path = normalizedPath(primitivePath(context, node));
          if (
            path === "nodeCrypto" &&
            parent.type === "VariableDeclarator" &&
            isAstNode(parent.id) &&
            parent.id.type === "ObjectPattern"
          ) {
            return;
          }
          if (!isPrimitive(path) && path !== "nodeCrypto") {
            return;
          }
          context.report({ node, messageId: "owned" });
        };
        const check = (node: ESTree.CallExpression | ESTree.NewExpression) => {
          if (isExempt()) {
            return;
          }
          const callee = unwrapExpression(node.callee);
          if (isIdentifierReference(callee)) {
            const variable = resolveVariable(context, callee);
            // The initializer/destructuring already reports this acquisition.
            if (variable?.defs.at(0)?.type === "Variable") {
              return;
            }
          }
          if (!Array.isArray(node.arguments)) {
            return;
          }
          const primitive = normalizedPath(primitivePath(context, node.callee));
          const algorithm = algorithmName(context, node.arguments.at(0));
          const sha256 =
            algorithm?.toLowerCase().replaceAll("-", "") === "sha256";
          if (primitive === "crypto.subtle.digest") {
            // CMS verification selects several digest algorithms from an OID.
            if (!sha256) {
              return;
            }
          } else if (primitive === "Bun.CryptoHasher") {
            const absentKey = isAbsentKey(context, node.arguments.at(1));
            if (!absentKey || (algorithm !== null && !sha256)) {
              return;
            }
          } else if (primitive === "createHash") {
            if (algorithm !== null && !sha256) {
              return;
            }
          } else if (
            primitive !== "Bun.SHA256" &&
            primitive !== "Bun.SHA256.hash"
          ) {
            return;
          }
          context.report({ node, messageId: "owned" });
        };
        return {
          CallExpression: check,
          NewExpression: check,
          Identifier(node) {
            if (isIdentifierReference(node)) {
              escaped(node);
            }
          },
          MemberExpression: escaped,
          VariableDeclarator(node) {
            if (isExempt() || node.id.type !== "ObjectPattern") {
              return;
            }
            for (const property of node.id.properties) {
              if (property.type !== "Property") {
                continue;
              }
              const key = property.computed
                ? staticStringValue(property.key)
                : isIdentifier(property.key)
                  ? property.key.name
                  : staticStringValue(property.key);
              const base = normalizedPath(primitivePath(context, node.init));
              const path =
                base === null || key === null
                  ? null
                  : normalizedPath(`${base}.${key}`);
              if (isPrimitive(path)) {
                context.report({ node: property, messageId: "owned" });
              }
            }
          },
          ExportAllDeclaration(node) {
            if (node.exportKind === "type") {
              return;
            }
            if (
              !isExempt() &&
              ["node:crypto", "crypto", "bun"].includes(node.source.value)
            ) {
              context.report({ node, messageId: "owned" });
            }
          },
          ExportNamedDeclaration(node) {
            if (node.exportKind === "type") {
              return;
            }
            if (
              isExempt() ||
              (node.source !== null &&
                node.source.value !== "node:crypto" &&
                node.source.value !== "crypto" &&
                node.source.value !== "bun")
            ) {
              return;
            }
            for (const specifier of node.specifiers) {
              if (specifier.exportKind === "type") {
                continue;
              }
              const name = isIdentifier(specifier.local)
                ? specifier.local.name
                : staticStringValue(specifier.local);
              if (
                node.source === null
                  ? isPrimitive(
                      normalizedPath(primitivePath(context, specifier.local)),
                    )
                  : ["createHash", "CryptoHasher", "SHA256"].includes(
                      name ?? "",
                    )
              ) {
                context.report({ node: specifier, messageId: "owned" });
              }
            }
          },
        };
      },
    },
  },
});
