import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  filenameForContext,
  getImportedName,
  getImportLocalName,
  getPropertyName,
  isAstNode,
  isIdentifier,
  isIdentifierReference,
  isStringLiteral,
  resolveVariable,
  unwrapExpression,
} from "./utils.ts";

const ACTION_SIZE_MODULE = "@/api/lib/rate-limit/action-size-limits";
const LIMITS_MODULE = "@/api/lib/limits";
const NORMALIZER = "normalizeTenantPageLimit";
const PAGE_VARIABLES = new Set(["limit", "pageSize", "windowSize"]);
const REQUEST_ROOTS = new Set(["query", "body", "input", "parsed"]);

// Public corpus readers have their own page budgets and do not own a tenant
// action. Native MCP tools stay in scope even when they call those readers.
const PUBLIC_CORPUS_PATHS = [
  "/handlers/case-law/",
  "/handlers/legislation/",
  "/lib/case-law/",
  "/lib/legal-search/",
  "/mcp/compat-corpus.ts",
];

const insideFunction = (node: unknown): boolean => {
  if (!isAstNode(node)) {
    return false;
  }
  let parent = node.parent;
  while (isAstNode(parent)) {
    if (
      parent.type === "ArrowFunctionExpression" ||
      parent.type === "FunctionExpression" ||
      parent.type === "FunctionDeclaration"
    ) {
      return true;
    }
    parent = parent.parent;
  }
  return false;
};

const requestRoot = (node: unknown): string | null => {
  const expression = unwrapExpression(node);
  if (isIdentifier(expression)) {
    return expression.name;
  }
  return expression?.type === "MemberExpression"
    ? requestRoot(expression.object)
    : null;
};

type PageSourceBindings = {
  limits: ReadonlySet<string>;
  defaults: ReadonlySet<string>;
};

const containsPageSource = (
  node: unknown,
  bindings: PageSourceBindings,
): boolean => {
  const expression = unwrapExpression(node);
  if (expression === null) {
    return false;
  }
  if (isIdentifier(expression) && bindings.defaults.has(expression.name)) {
    return true;
  }
  if (expression.type === "MemberExpression") {
    const property = getPropertyName(expression.property);
    if (
      isIdentifier(expression.object) &&
      bindings.limits.has(expression.object.name) &&
      property !== null &&
      /(?:PageSizeDefault|windowSizeDefault)$/u.test(property)
    ) {
      return true;
    }
    const root = requestRoot(expression.object);
    if (property !== null && PAGE_VARIABLES.has(property) && root !== null) {
      return REQUEST_ROOTS.has(root);
    }
  }
  // Only walk value expressions. A query builder's `.limit(...)` is a method,
  // not a requested page size; callback bodies and schema types are not values
  // of the enclosing resolved-page declaration either.
  for (const [key, value] of Object.entries(expression)) {
    if (
      key === "parent" ||
      key === "callee" ||
      key === "typeAnnotation" ||
      key === "body"
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      if (value.some((child) => containsPageSource(child, bindings))) {
        return true;
      }
    } else if (containsPageSource(value, bindings)) {
      return true;
    }
  }
  return false;
};

export default eslintCompatPlugin({
  meta: { name: "require-tenant-page-limit" },
  rules: {
    "require-tenant-page-limit": {
      meta: {
        type: "problem",
        messages: {
          normalizeResolvedPage: `Resolve tenant page sizes with normalizeTenantPageLimit(...) from ${
            ACTION_SIZE_MODULE
          } before executing the page query; wrap the complete default/clamp expression.`,
        },
      },
      createOnce(context) {
        const pageSources = {
          limits: new Set<string>(),
          defaults: new Set<string>(),
        };
        let anonymousPublic = false;
        return {
          before() {
            pageSources.limits.clear();
            pageSources.defaults.clear();
            anonymousPublic = false;
            const filename = filenameForContext(context);
            if (
              /\.oxlint-plugins\/__fixtures__\/require-tenant-page-limit\.fixture\.tsx?$/u.test(
                filename,
              )
            ) {
              return true;
            }
            return (
              /apps\/api\/src\/(?:handlers|lib|mcp)\//u.test(filename) &&
              !/\.(?:test|spec)\.ts$/u.test(filename) &&
              !PUBLIC_CORPUS_PATHS.some((part) => filename.includes(part))
            );
          },
          ImportDeclaration(node) {
            if (!isStringLiteral(node.source)) {
              return;
            }
            for (const specifier of node.specifiers) {
              const imported = getImportedName(specifier);
              const local = getImportLocalName(specifier);
              if (
                node.source.value === LIMITS_MODULE &&
                imported === "LIMITS" &&
                local !== null
              ) {
                pageSources.limits.add(local);
              }
              if (
                node.source.value === "@/api/mcp/tool-utils" &&
                (imported === "DEFAULT_LIST_LIMIT" ||
                  imported === "DEFAULT_SEARCH_LIMIT") &&
                local !== null
              ) {
                pageSources.defaults.add(local);
              }
              if (
                node.source.value === "@/api/lib/api-handlers" &&
                (imported === "createSafePublicHandler" ||
                  imported === "createSafeBoundedPublicHandler")
              ) {
                anonymousPublic = true;
              }
            }
          },
          VariableDeclarator(node) {
            if (
              anonymousPublic ||
              !isIdentifier(node.id) ||
              !PAGE_VARIABLES.has(node.id.name) ||
              !insideFunction(node) ||
              !containsPageSource(node.init, pageSources)
            ) {
              return;
            }
            const expression = unwrapExpression(node.init);
            if (
              expression?.type === "CallExpression" &&
              isIdentifierReference(expression.callee)
            ) {
              const binding = resolveVariable(context, expression.callee);
              const canonical = binding?.defs.some(
                (definition) =>
                  definition.type === "ImportBinding" &&
                  getImportedName(definition.node) === NORMALIZER &&
                  isAstNode(definition.parent) &&
                  isStringLiteral(definition.parent.source) &&
                  definition.parent.source.value === ACTION_SIZE_MODULE,
              );
              if (canonical) {
                return;
              }
            }
            context.report({ node, messageId: "normalizeResolvedPage" });
          },
        };
      },
    },
  },
});
