/**
 * Invariant: statically identified controller editor text/command accesses use
 * getLiveEditor at the point of use.
 *
 * Rejected: getText/commands access or destructuring through useChatEditor's
 * editor, local aliases, and imported ChatEditorController parameter/prop types.
 * Accepted: accesses on getLiveEditor(editor) results and unrelated editors.
 *
 * Boundary: local import, binding and type-shape detection only. Not tracked:
 * ChatEditorController["editor"]-typed parameters, editors stored in refs or
 * returned by other helpers, and getLiveEditor handles retained across await.
 * Static detection does not guarantee runtime liveness; reacquire the live
 * editor after an asynchronous boundary.
 */
import { eslintCompatPlugin, type Variable } from "@oxlint/plugins";

import {
  type AstNode,
  canonicalModuleId,
  type FilenameContext,
  getPropertyName,
  isAstNode,
  isIdentifierReference,
  isStringLiteral,
  memberPropertyName,
  repoRelativeFilename,
  resolveImport,
  resolveVariable,
  type ScopeContext,
  unwrapExpression,
} from "./utils.ts";

const CONTROLLER_MODULE = "apps/web/src/components/chat-editor-provider";
type Origin = "controller" | "editor" | null;

// Recover the projection selected by a nested destructuring binding.
const bindingPath = (pattern: unknown, target: unknown): string[] | null => {
  if (pattern === target) {
    return [];
  }
  if (!isAstNode(pattern)) {
    return null;
  }
  if (pattern.type === "AssignmentPattern") {
    return bindingPath(pattern.left, target);
  }
  if (pattern.type !== "ObjectPattern" || !Array.isArray(pattern.properties)) {
    return null;
  }
  for (const property of pattern.properties) {
    if (!isAstNode(property) || property.type !== "Property") {
      continue;
    }
    const path = bindingPath(property.value, target);
    const key = getPropertyName(property.key);
    if (path !== null && key !== null) {
      return [key, ...path];
    }
  }
  return null;
};

const createResolver = (context: ScopeContext & FilenameContext) => {
  const fromType = (
    input: unknown,
    path: readonly string[],
    seen = new Set<unknown>(),
  ): Origin => {
    if (seen.has(input)) {
      return null;
    }
    seen.add(input);
    if (!isAstNode(input)) {
      return null;
    }
    if (input.type === "TSTypeAnnotation") {
      return fromType(input.typeAnnotation, path, seen);
    }
    if (input.type === "TSTypeReference") {
      if (!isIdentifierReference(input.typeName)) {
        return null;
      }
      const definition = resolveVariable(context, input.typeName)?.defs.at(0);
      if (isAstNode(definition?.node)) {
        if (definition.node.type === "TSTypeAliasDeclaration") {
          return fromType(definition.node.typeAnnotation, path, seen);
        }
        if (definition.node.type === "TSInterfaceDeclaration") {
          return fromType(definition.node.body, path, seen);
        }
      }
      if (
        definition?.type !== "ImportBinding" ||
        !isAstNode(definition.node) ||
        !isAstNode(definition.parent) ||
        !isStringLiteral(definition.parent.source)
      ) {
        return null;
      }
      return canonicalModuleId(
        definition.parent.source.value,
        repoRelativeFilename(context),
      ) === CONTROLLER_MODULE &&
        getPropertyName(definition.node.imported) === "ChatEditorController"
        ? project("controller", path)
        : null;
    }
    const members =
      input.type === "TSInterfaceBody" ? input.body : input.members;
    if (
      !["TSTypeLiteral", "TSInterfaceBody"].includes(input.type) ||
      !Array.isArray(members)
    ) {
      return null;
    }
    const [key, ...rest] = path;
    const member = members.find(
      (entry) => isAstNode(entry) && getPropertyName(entry.key) === key,
    );
    return isAstNode(member)
      ? fromType(member.typeAnnotation, rest, seen)
      : null;
  };
  const project = (origin: Origin, path: readonly string[]): Origin => {
    if (path.length === 0) {
      return origin;
    }
    return origin === "controller" &&
      path.length === 1 &&
      path.at(0) === "editor"
      ? "editor"
      : null;
  };
  const resolve = (input: unknown, seen = new Set<Variable>()): Origin => {
    const node = unwrapExpression(input);
    if (!node) {
      return null;
    }
    if (node.type === "TSNonNullExpression") {
      return resolve(node.expression, seen);
    }
    if (node.type === "CallExpression") {
      const imported = resolveImport(context, node.callee);
      return imported?.moduleId === CONTROLLER_MODULE &&
        imported.imported === "useChatEditor"
        ? "controller"
        : null;
    }
    if (node.type === "MemberExpression") {
      const key = memberPropertyName(node);
      return key === null ? null : project(resolve(node.object, seen), [key]);
    }
    if (!isIdentifierReference(node)) {
      return null;
    }
    const variable = resolveVariable(context, node);
    if (variable === null || seen.has(variable)) {
      return null;
    }
    seen.add(variable);
    const definition = variable.defs.at(0);
    if (!definition || !isAstNode(definition.node)) {
      return null;
    }
    const declaration = definition.node;
    if (declaration.type === "VariableDeclarator") {
      const path = bindingPath(declaration.id, definition.name);
      if (path === null) {
        return null;
      }
      const origin = resolve(declaration.init, seen);
      return (
        project(origin, path) ??
        (isAstNode(declaration.id)
          ? fromType(declaration.id.typeAnnotation, path)
          : null)
      );
    }
    // Parameter definitions point at their function; the identifier retains its
    // containing pattern, including an enclosing object's type annotation.
    if (!isAstNode(definition.name)) {
      return null;
    }
    let pattern: AstNode = definition.name;
    while (
      isAstNode(pattern.parent) &&
      ["Property", "ObjectPattern", "AssignmentPattern"].includes(
        pattern.parent.type,
      )
    ) {
      pattern = pattern.parent;
    }
    const path = bindingPath(pattern, definition.name);
    return path === null ? null : fromType(pattern.typeAnnotation, path);
  };
  return resolve;
};

export default eslintCompatPlugin({
  meta: { name: "no-unsafe-controller-editor-access" },
  rules: {
    "no-unsafe-controller-editor-access": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          unsafe:
            "Read controller editor text and commands through getLiveEditor from @/components/live-editor so destroyed editors are rejected.",
        },
      },
      createOnce(context) {
        const origin = createResolver(context);
        return {
          MemberExpression(node) {
            if (!isAstNode(node)) {
              return;
            }
            if (
              !["getText", "commands"].includes(memberPropertyName(node) ?? "")
            ) {
              return;
            }
            if (origin(node.object) === "editor") {
              context.report({ node, messageId: "unsafe" });
            }
          },
          VariableDeclarator(node) {
            const checkPattern = (pattern: unknown, source: Origin) => {
              if (
                !isAstNode(pattern) ||
                pattern.type !== "ObjectPattern" ||
                !Array.isArray(pattern.properties)
              ) {
                return;
              }
              for (const property of pattern.properties) {
                if (!isAstNode(property) || property.type !== "Property") {
                  continue;
                }
                const key = getPropertyName(property.key);
                if (
                  source === "editor" &&
                  ["getText", "commands"].includes(key ?? "")
                ) {
                  context.report({ node: property, messageId: "unsafe" });
                }
                checkPattern(
                  property.value,
                  source === "controller" && key === "editor" ? "editor" : null,
                );
              }
            };
            checkPattern(node.id, origin(node.init));
          },
        };
      },
    },
  },
});
