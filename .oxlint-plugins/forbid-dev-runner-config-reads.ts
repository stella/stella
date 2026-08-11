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

const CONFIG_ENV_NAMES = new Set([
  "STELLA_DEV_INSTANCE",
  "STELLA_INFRA_OFFSET",
  "STELLA_PORT_OFFSET",
]);

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
        };
      },
    },
  },
});
