// Disallow unvalidated process.env access outside approved env boundaries.
// Environment variables should be read through env.ts/env-base.ts so
// validation and normalization happen once at process startup. Direct
// process.env access in product code bypasses config safety and tends to
// spread fallback parsing across call sites.
//
// Flags:
//   const token = process.env["TOKEN"];
//   const mode = process.env.NODE_ENV;
//   spawn(cmd, { env: process.env });
//
// Allows by default:
//   env.ts / env-base.ts
//   *.config.ts
//   *.test.ts / *.spec.ts
//   scripts, test setup, and explicitly configured boundary files

import { getPropertyName, isIdentifier, isStringLiteral } from "./utils.ts";

type AstNode = { type: string } & Record<string, unknown>;

type RuleContext = {
  filename?: string;
  getFilename?: () => string;
  options?: unknown[];
  report: (diagnostic: {
    node: unknown;
    messageId: "processEnv";
    data: { envName: string };
  }) => void;
};

const DEFAULT_ALLOWED_FILE_PATTERNS = [
  /(?:^|\/)env(?:-base)?\.ts$/u,
  /(?:^|\/)setup-env\.ts$/u,
  /(?:^|\/)(?:scripts|tests|__tests__)\/.+/u,
  /\.(?:config|test|spec)\.[cm]?[jt]sx?$/u,
];

const filenameForContext = (context: RuleContext): string =>
  context.filename ?? context.getFilename?.() ?? "";

const normalizePath = (filename: string): string =>
  filename.replaceAll("\\", "/");

const stringArrayOption = (options: Record<string, unknown>, key: string) => {
  const value = options[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
};

const isAllowedFile = (
  filename: string,
  allowedFiles: readonly string[],
): boolean => {
  const normalized = normalizePath(filename);
  if (
    DEFAULT_ALLOWED_FILE_PATTERNS.some((pattern) => pattern.test(normalized))
  ) {
    return true;
  }
  return allowedFiles.some((allowedFile) =>
    normalized.endsWith(normalizePath(allowedFile)),
  );
};

const isAstNode = (node: unknown): node is AstNode =>
  typeof node === "object" &&
  node !== null &&
  "type" in node &&
  typeof node.type === "string";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const staticMemberPropertyName = (node: AstNode): string | null => {
  if (node.computed === false) {
    return getPropertyName(node.property);
  }
  return isStringLiteral(node.property) ? node.property.value : null;
};

const isProcessEnvRoot = (node: unknown): boolean =>
  isAstNode(node) &&
  node.type === "MemberExpression" &&
  isIdentifier(node.object, "process") &&
  staticMemberPropertyName(node) === "env";

const envNameForAccess = (node: AstNode): string => {
  if (isProcessEnvRoot(node)) {
    return "process.env";
  }
  if (
    node.type === "MemberExpression" &&
    isProcessEnvRoot(node.object) &&
    isAstNode(node.property)
  ) {
    const propertyName = staticMemberPropertyName(node);
    if (propertyName === null) {
      return "process.env[...]";
    }
    if (node.computed === true) {
      return `process.env[${JSON.stringify(propertyName)}]`;
    }
    return `process.env.${propertyName}`;
  }
  return "process.env";
};

const isNestedProcessEnvRoot = (node: AstNode): boolean => {
  if (!isProcessEnvRoot(node)) {
    return false;
  }
  const parent = node.parent;
  return (
    isAstNode(parent) &&
    parent.type === "MemberExpression" &&
    parent.object === node
  );
};

const isProcessEnvAccess = (node: AstNode): boolean => {
  if (isNestedProcessEnvRoot(node)) {
    return false;
  }
  if (isProcessEnvRoot(node)) {
    return true;
  }
  return node.type === "MemberExpression" && isProcessEnvRoot(node.object);
};

export default {
  meta: { name: "forbid-process-env-outside-env-ts" },
  rules: {
    "forbid-process-env-outside-env-ts": {
      meta: {
        type: "problem",
        messages: {
          processEnv:
            "Read {{envName}} through an env module, or add this file to the approved process.env boundary allowlist.",
        },
        schema: [
          {
            type: "object",
            properties: {
              allowedFiles: {
                type: "array",
                items: { type: "string" },
              },
            },
            additionalProperties: false,
          },
        ],
      },
      create(context: RuleContext) {
        const options = isRecord(context.options?.[0])
          ? context.options[0]
          : {};
        const allowedFiles = stringArrayOption(options, "allowedFiles");

        if (isAllowedFile(filenameForContext(context), allowedFiles)) {
          return {};
        }

        return {
          MemberExpression(node: AstNode) {
            if (!isProcessEnvAccess(node)) {
              return;
            }
            context.report({
              node,
              messageId: "processEnv",
              data: { envName: envNameForAccess(node) },
            });
          },
        };
      },
    },
  },
};
