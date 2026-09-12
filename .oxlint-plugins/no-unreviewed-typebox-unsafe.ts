import { eslintCompatPlugin, type ESTree } from "@oxlint/plugins";

import {
  filenameForContext,
  getImportedName,
  isAstNode,
  isIdentifier,
  isStringLiteral,
  unwrapExpression,
} from "./utils.ts";

const TYPEBOX_MODULES = new Set(["@sinclair/typebox", "typebox"]);
const ELYSIA_MODULE = "elysia";

type SchemaBinding =
  | "elysiaNamespace"
  | "elysiaT"
  | "typeboxNamespace"
  | "typeboxType"
  | "typeboxUnsafe";

type ApprovedAdapter = {
  binding: string;
  path: string;
  reason: string;
};

type AdapterBinding = {
  name: string;
  node: object;
  ownsUnsafeCall: boolean;
};

const FUNCTION_EXPRESSION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
]);

const isIdentifierReference = (
  node: unknown,
): node is ESTree.IdentifierReference =>
  isIdentifier(node) && Array.isArray(node.range);

const configuredApprovedAdapters = (options: unknown): ApprovedAdapter[] => {
  if (
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options)
  ) {
    return [];
  }
  const configured = Reflect.get(options, "approvedAdapters");
  if (!Array.isArray(configured)) {
    return [];
  }
  const adapters: ApprovedAdapter[] = [];
  for (const entry of configured) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const binding = Reflect.get(entry, "binding");
    const path = Reflect.get(entry, "path");
    const reason = Reflect.get(entry, "reason");
    if (
      typeof binding === "string" &&
      typeof path === "string" &&
      typeof reason === "string" &&
      reason.trim().length > 0
    ) {
      adapters.push({ binding, path, reason });
    }
  }
  return adapters;
};

const adapterBinding = (node: unknown): AdapterBinding | null => {
  let current = isAstNode(node) ? node.parent : null;
  let enclosingFunction: object | null = null;
  while (isAstNode(current)) {
    if (current.type === "VariableDeclarator" && isIdentifier(current.id)) {
      return {
        name: current.id.name,
        node: current,
        ownsUnsafeCall:
          enclosingFunction === null ||
          unwrapExpression(current.init) === enclosingFunction,
      };
    }
    if (current.type === "FunctionDeclaration" && isIdentifier(current.id)) {
      return {
        name: current.id.name,
        node: current,
        ownsUnsafeCall: enclosingFunction === null,
      };
    }
    if (FUNCTION_EXPRESSION_TYPES.has(current.type)) {
      enclosingFunction ??= current;
    }
    current = current.parent;
  }
  return null;
};

const memberPropertyName = (member: unknown): string | null => {
  if (!isAstNode(member) || member.type !== "MemberExpression") {
    return null;
  }
  if (member.computed) {
    return isStringLiteral(member.property) ? member.property.value : null;
  }
  return isIdentifier(member.property) ? member.property.name : null;
};

const objectPatternPropertyPath = (
  pattern: unknown,
  name: string,
): string[] | null => {
  if (isIdentifier(pattern)) {
    return pattern.name === name ? [] : null;
  }
  if (!isAstNode(pattern) || pattern.type !== "ObjectPattern") {
    return null;
  }
  const properties = Array.isArray(pattern.properties)
    ? pattern.properties
    : [];
  for (const property of properties) {
    if (
      !isAstNode(property) ||
      property.type !== "Property" ||
      property.computed
    ) {
      continue;
    }
    const propertyName = isIdentifier(property.key)
      ? property.key.name
      : isStringLiteral(property.key)
        ? property.key.value
        : null;
    if (propertyName === null) {
      continue;
    }
    const nested = objectPatternPropertyPath(property.value, name);
    if (nested !== null) {
      return [propertyName, ...nested];
    }
  }
  return null;
};

const isTopLevelBinding = (binding: object): boolean => {
  let parent = isAstNode(binding) ? binding.parent : null;
  if (isAstNode(parent) && parent.type === "VariableDeclaration") {
    parent = parent.parent;
  }
  if (isAstNode(parent) && parent.type === "ExportNamedDeclaration") {
    parent = parent.parent;
  }
  return isAstNode(parent) && parent.type === "Program";
};

export default eslintCompatPlugin({
  meta: { name: "no-unreviewed-typebox-unsafe" },
  rules: {
    "no-unreviewed-typebox-unsafe": {
      meta: {
        type: "problem",
        messages: {
          unreviewedTypeboxUnsafe:
            "Type.Unsafe manually pairs a static type with a runtime schema. Prefer TypeBox builders, or add an exact reviewed adapter binding with its reason to approvedAdapters.",
          staleApprovedAdapter:
            "Approved Type.Unsafe adapter '{{binding}}' for '{{path}}' no longer owns a top-level Type.Unsafe call. Remove or update the approvedAdapters entry.",
          duplicateApprovedAdapter:
            "Approved Type.Unsafe adapter '{{binding}}' for '{{path}}' is configured more than once. Keep one entry that owns the reviewed call.",
        },
        schema: [
          {
            type: "object",
            properties: {
              approvedAdapters: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    binding: { type: "string" },
                    path: { type: "string" },
                    reason: { type: "string", minLength: 1 },
                  },
                  required: ["binding", "path", "reason"],
                  additionalProperties: false,
                },
              },
            },
            additionalProperties: false,
          },
        ],
      },
      createOnce(context) {
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

        const importedBindingFor = (
          identifier: ESTree.IdentifierReference,
        ): SchemaBinding | null => {
          const variable = resolveVariable(identifier);
          if (variable === null) {
            return null;
          }
          for (const definition of variable.defs) {
            if (
              definition.type !== "ImportBinding" ||
              definition.parent?.type !== "ImportDeclaration"
            ) {
              continue;
            }
            const source = definition.parent.source.value;
            if (TYPEBOX_MODULES.has(source)) {
              if (
                definition.node.type === "ImportDefaultSpecifier" ||
                definition.node.type === "ImportNamespaceSpecifier"
              ) {
                return "typeboxNamespace";
              }
              const imported = getImportedName(definition.node);
              if (imported === "Type") {
                return "typeboxType";
              }
              if (imported === "Unsafe") {
                return "typeboxUnsafe";
              }
            }
            if (source === ELYSIA_MODULE) {
              if (definition.node.type === "ImportNamespaceSpecifier") {
                return "elysiaNamespace";
              }
              if (getImportedName(definition.node) === "t") {
                return "elysiaT";
              }
            }
          }
          return null;
        };

        const constantBindingSource = (
          identifier: ESTree.IdentifierReference,
        ): { initializer: unknown; propertyPath: string[] } | null => {
          const variable = resolveVariable(identifier);
          if (variable === null) {
            return null;
          }
          for (const definition of variable.defs) {
            if (
              definition.type !== "Variable" ||
              !isAstNode(definition.node) ||
              definition.node.type !== "VariableDeclarator" ||
              !isAstNode(definition.parent) ||
              definition.parent.type !== "VariableDeclaration" ||
              definition.parent.kind !== "const"
            ) {
              continue;
            }
            const propertyPath = objectPatternPropertyPath(
              definition.node.id,
              identifier.name,
            );
            if (propertyPath === null) {
              return null;
            }
            return { initializer: definition.node.init, propertyPath };
          }
          return null;
        };

        const projectedBinding = (
          binding: SchemaBinding | null,
          property: string,
        ): SchemaBinding | null => {
          if (binding === "typeboxNamespace") {
            if (property === "Type") {
              return "typeboxType";
            }
            return property === "Unsafe" ? "typeboxUnsafe" : null;
          }
          if (binding === "typeboxType" && property === "Unsafe") {
            return "typeboxUnsafe";
          }
          if (binding === "elysiaNamespace" && property === "t") {
            return "elysiaT";
          }
          return binding === "elysiaT" && property === "Unsafe"
            ? "typeboxUnsafe"
            : null;
        };

        const resolveBinding = (
          node: unknown,
          seen = new Set<unknown>(),
        ): SchemaBinding | null => {
          const expression = unwrapExpression(node);
          if (isIdentifierReference(expression)) {
            const imported = importedBindingFor(expression);
            if (imported !== null) {
              return imported;
            }
            const variable = resolveVariable(expression);
            if (variable === null || seen.has(variable)) {
              return null;
            }
            const source = constantBindingSource(expression);
            if (source === null) {
              return null;
            }
            const nextSeen = new Set(seen);
            nextSeen.add(variable);
            let binding = resolveBinding(source.initializer, nextSeen);
            for (const property of source.propertyPath) {
              binding = projectedBinding(binding, property);
              if (binding === null) {
                return null;
              }
            }
            return binding;
          }
          if (
            !isAstNode(expression) ||
            expression.type !== "MemberExpression"
          ) {
            return null;
          }
          const property = memberPropertyName(expression);
          return property === null
            ? null
            : projectedBinding(
                resolveBinding(expression.object, seen),
                property,
              );
        };

        let applicableApprovedAdapters: ApprovedAdapter[] = [];
        let filename = "";
        let consumedApprovedAdapters = new Set<ApprovedAdapter>();

        return {
          before() {
            filename = filenameForContext(context);
            applicableApprovedAdapters = configuredApprovedAdapters(
              context.options.at(0),
            ).filter(
              (adapter) =>
                filename === adapter.path ||
                filename.endsWith(`/${adapter.path}`),
            );
            consumedApprovedAdapters = new Set();
          },
          CallExpression(node) {
            if (resolveBinding(node.callee) !== "typeboxUnsafe") {
              return;
            }
            const binding = adapterBinding(node);
            const matchingAdapters =
              binding === null ||
              !binding.ownsUnsafeCall ||
              !isTopLevelBinding(binding.node)
                ? []
                : applicableApprovedAdapters.filter(
                    (adapter) => adapter.binding === binding.name,
                  );
            const matchingAdapter = matchingAdapters.at(0);
            if (
              matchingAdapters.length === 1 &&
              matchingAdapter !== undefined &&
              !consumedApprovedAdapters.has(matchingAdapter)
            ) {
              consumedApprovedAdapters.add(matchingAdapter);
              return;
            }
            context.report({ node, messageId: "unreviewedTypeboxUnsafe" });
          },
          "Program:exit"(node) {
            const approvalsByBinding = new Map<
              string,
              [ApprovedAdapter, ...ApprovedAdapter[]]
            >();
            for (const adapter of applicableApprovedAdapters) {
              const approvals = approvalsByBinding.get(adapter.binding);
              if (approvals === undefined) {
                approvalsByBinding.set(adapter.binding, [adapter]);
                continue;
              }
              approvals.push(adapter);
            }
            for (const approvals of approvalsByBinding.values()) {
              const [approval, ...duplicates] = approvals;
              if (duplicates.length > 0) {
                for (const duplicate of duplicates) {
                  context.report({
                    node,
                    messageId: "duplicateApprovedAdapter",
                    data: duplicate,
                  });
                }
                continue;
              }
              if (consumedApprovedAdapters.has(approval)) {
                continue;
              }
              context.report({
                node,
                messageId: "staleApprovedAdapter",
                data: approval,
              });
            }
            // This per-file rule cannot observe an approval whose configured
            // path is deleted or omitted from the lint invocation. A separate
            // config-wide path census must own that repository-level check.
          },
        };
      },
    },
  },
});
