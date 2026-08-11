// Keep dev-runner configuration reads in dev-runner-config.ts. The runner may
// still pass the ambient environment to child processes, but it must not parse
// CLI or runner-specific environment inputs after side effects begin.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  getPropertyName,
  isAstNode,
  isIdentifier,
  isStringLiteral,
} from "./utils.ts";

export const DEV_RUNNER_CONFIG_ENV_NAMES = [
  "STELLA_DEV_INSTANCE",
  "STELLA_INFRA_OFFSET",
  "STELLA_PORT_OFFSET",
] as const;
const CONFIG_ENV_NAMES = new Set(DEV_RUNNER_CONFIG_ENV_NAMES);
const ARGV_NAMES = new Set(["argv"]);

const staticPropertyName = (node: Record<string, unknown>): string | null => {
  if (node.computed === false) {
    return getPropertyName(node.property);
  }
  return isStringLiteral(node.property) ? node.property.value : null;
};

const isProcessAccess = (node: unknown, property: string): boolean =>
  isAstNode(node) &&
  node.type === "MemberExpression" &&
  isIdentifier(node.object, "process") &&
  staticPropertyName(node) === property;

const isRunnerConfigEnvironmentAccess = (node: unknown): boolean => {
  if (!isAstNode(node) || node.type !== "MemberExpression") {
    return false;
  }
  if (!isProcessAccess(node.object, "env")) {
    return false;
  }
  const name = staticPropertyName(node);
  return name !== null && CONFIG_ENV_NAMES.has(name);
};

const isObjectPatternWithProperty = (
  node: unknown,
  names: ReadonlySet<string>,
): boolean => {
  if (!isAstNode(node) || node.type !== "ObjectPattern") {
    return false;
  }
  const properties = node.properties;
  if (!Array.isArray(properties)) {
    return false;
  }
  return properties.some((property) => {
    if (!isAstNode(property) || property.type !== "Property") {
      return false;
    }
    const key = getPropertyName(property.key);
    return key !== null && names.has(key);
  });
};

const isRunnerConfigDestructuring = (node: unknown): boolean => {
  if (!isAstNode(node) || node.type !== "VariableDeclarator") {
    return false;
  }
  if (isIdentifier(node.init, "process")) {
    return isObjectPatternWithProperty(node.id, ARGV_NAMES);
  }
  return (
    isProcessAccess(node.init, "env") &&
    isObjectPatternWithProperty(node.id, CONFIG_ENV_NAMES)
  );
};

export default eslintCompatPlugin({
  meta: { name: "forbid-dev-runner-config-reads" },
  rules: {
    "forbid-dev-runner-config-reads": {
      meta: {
        type: "problem",
        messages: {
          configRead:
            "Read dev-runner CLI and configuration environment values through dev-runner-config.ts.",
        },
      },
      createOnce(context) {
        return {
          MemberExpression(node) {
            if (
              isProcessAccess(node, "argv") ||
              isRunnerConfigEnvironmentAccess(node)
            ) {
              context.report({ node, messageId: "configRead" });
            }
          },
          VariableDeclarator(node) {
            if (isRunnerConfigDestructuring(node)) {
              context.report({ node, messageId: "configRead" });
            }
          },
        };
      },
    },
  },
});
