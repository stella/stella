// Ban render-body ref mirrors.
//
// The pattern `const valueRef = useRef(value); valueRef.current = value`
// keeps a mutable copy of render data around to dodge stale closures. In React
// 19, useEffectEvent is the structural primitive for reading fresh values from
// effect-installed callbacks. This rule intentionally catches only the precise
// render-body mirror assignment and ignores DOM refs, timers, queues, and
// assignments inside callbacks/effects.

import { getImportedName, isIdentifier } from "./utils.ts";

const REACT_MODULE = "react";

const filenameForContext = (context) =>
  context.filename ?? context.getFilename?.() ?? "";

const isAllowedFile = (context, allowedFiles) => {
  const filename = filenameForContext(context);
  return allowedFiles.some((allowedFile) => {
    if (typeof allowedFile === "string") {
      return filename.endsWith(allowedFile);
    }
    if (
      typeof allowedFile === "object" &&
      allowedFile !== null &&
      typeof allowedFile.path === "string"
    ) {
      return filename.endsWith(allowedFile.path);
    }
    return false;
  });
};

const findContainingFunction = (node) => {
  let current = node.parent;
  while (current) {
    if (
      current.type === "FunctionDeclaration" ||
      current.type === "FunctionExpression" ||
      current.type === "ArrowFunctionExpression"
    ) {
      return current;
    }
    current = current.parent;
  }
  return null;
};

const isUseRefCall = (node, useRefAliases, reactNamespaces) => {
  if (node?.type !== "CallExpression") {
    return false;
  }

  const callee = node.callee;
  if (isIdentifier(callee) && useRefAliases.has(callee.name)) {
    return true;
  }

  return (
    callee.type === "MemberExpression" &&
    callee.computed === false &&
    isIdentifier(callee.object) &&
    reactNamespaces.has(callee.object.name) &&
    isIdentifier(callee.property, "useRef")
  );
};

const getTopLevelRenderAssignment = (node) => {
  if (node.parent?.type !== "ExpressionStatement") {
    return null;
  }

  let current = node.parent.parent;
  while (current) {
    if (current.type === "BlockStatement") {
      return current.parent ?? null;
    }
    if (
      current.type === "FunctionDeclaration" ||
      current.type === "FunctionExpression" ||
      current.type === "ArrowFunctionExpression"
    ) {
      return current;
    }
    current = current.parent;
  }

  return null;
};

export default {
  meta: { name: "no-ref-mirror" },
  rules: {
    "no-ref-mirror": {
      meta: {
        type: "problem",
        messages: {
          noRefMirror:
            "Do not mirror '{{source}}' into '{{ref}}.current' during render. Use useEffectEvent for effect-installed callbacks that need fresh values, or derive the value directly during render.",
        },
        schema: [
          {
            type: "object",
            properties: {
              allowedFiles: {
                type: "array",
                items: {
                  anyOf: [
                    { type: "string" },
                    {
                      type: "object",
                      properties: {
                        path: { type: "string" },
                        reason: { type: "string" },
                      },
                      required: ["path", "reason"],
                      additionalProperties: false,
                    },
                  ],
                },
              },
            },
            additionalProperties: false,
          },
        ],
      },
      create(context) {
        const options = context.options?.[0] ?? {};
        const allowedFiles = Array.isArray(options.allowedFiles)
          ? options.allowedFiles
          : [];

        if (isAllowedFile(context, allowedFiles)) {
          return {};
        }

        const useRefAliases = new Set();
        const reactNamespaces = new Set();
        const mirroredRefsByFunction = new WeakMap();

        const mirroredRefsForFunction = (functionNode) => {
          const existing = mirroredRefsByFunction.get(functionNode);
          if (existing) {
            return existing;
          }
          const next = new Map();
          mirroredRefsByFunction.set(functionNode, next);
          return next;
        };

        return {
          ImportDeclaration(node) {
            if (node.source?.value !== REACT_MODULE) {
              return;
            }

            for (const specifier of node.specifiers) {
              if (
                specifier.type === "ImportDefaultSpecifier" ||
                specifier.type === "ImportNamespaceSpecifier"
              ) {
                reactNamespaces.add(specifier.local.name);
                continue;
              }
              if (
                specifier.type === "ImportSpecifier" &&
                getImportedName(specifier) === "useRef"
              ) {
                useRefAliases.add(specifier.local.name);
              }
            }
          },

          VariableDeclarator(node) {
            if (
              !isIdentifier(node.id) ||
              !isUseRefCall(node.init, useRefAliases, reactNamespaces)
            ) {
              return;
            }

            const [initialValue] = node.init.arguments ?? [];
            if (!isIdentifier(initialValue)) {
              return;
            }

            const functionNode = findContainingFunction(node);
            if (functionNode === null) {
              return;
            }

            mirroredRefsForFunction(functionNode).set(
              node.id.name,
              initialValue.name,
            );
          },

          AssignmentExpression(node) {
            if (node.operator !== "=") {
              return;
            }
            if (
              node.left.type !== "MemberExpression" ||
              node.left.computed !== false ||
              !isIdentifier(node.left.object) ||
              !isIdentifier(node.left.property, "current") ||
              !isIdentifier(node.right)
            ) {
              return;
            }

            const functionNode = findContainingFunction(node);
            if (functionNode === null) {
              return;
            }
            if (getTopLevelRenderAssignment(node) !== functionNode) {
              return;
            }

            const mirroredRefs = mirroredRefsByFunction.get(functionNode);
            const source = mirroredRefs?.get(node.left.object.name);
            if (source !== node.right.name) {
              return;
            }

            context.report({
              node,
              messageId: "noRefMirror",
              data: { ref: node.left.object.name, source },
            });
          },
        };
      },
    },
  },
};
