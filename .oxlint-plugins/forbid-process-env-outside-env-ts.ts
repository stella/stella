// Disallow unvalidated environment access outside approved env boundaries.
// Environment variables should be read through env.ts/env-base.ts so
// validation and normalization happen once at process startup. Direct
// environment access in product code skips config validation and tends to
// spread fallback parsing across call sites.
//
// The environment object is recognised by what it is bound to, in every
// spelling that reaches it:
//   process.env.NODE_ENV, process["env"], globalThis.process.env
//   const { env } = process
//   import process from "node:process"; process.env
//   import { env } from "node:process"
//   Bun.env
//   import.meta.env   (server code only: in the Vite client apps it is the
//                      build-time contract, not the process environment)
//
// Allows by default:
//   env.ts / env-base.ts / setup-env.ts at any depth
//   *.config.* and *.test.* / *.spec.* files, __tests__ directories
//   the repository `scripts/` directory, and a package's own `scripts/`,
//   `test/` or `tests/` directory (`apps/<app>/scripts/`,
//   `packages/<package>/tests/`), never a nested one
//   explicitly configured boundary files (`allowedFiles`) and tooling
//   directories (`allowedDirectories`, repository-relative prefixes)

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  getImportedName,
  getPropertyName,
  isAstNode,
  isIdentifier,
  isIdentifierReference,
  isStringLiteral,
  memberPropertyName,
  repoRelativeFilename,
  resolveImport,
  resolveVariable,
  stableInitializer,
  unwrapExpression,
} from "./utils.ts";

const DEFAULT_ALLOWED_FILE_PATTERNS = [
  /(?:^|\/)env(?:-base)?\.ts$/u,
  /(?:^|\/)setup-env\.ts$/u,
  /^scripts\//u,
  /^(?:apps|packages)\/[^/]+\/(?:scripts|tests?)\//u,
  /(?:^|\/)__tests__\//u,
  /\.(?:config|test|spec)\.[cm]?[jt]sx?$/u,
];

// Vite client apps read `import.meta.env` as their build-time contract.
const VITE_CLIENT_ROOT = /^apps\/(?:desktop|landing|mobile|playground|web)\//u;

const PROCESS_MODULES: ReadonlySet<string> = new Set([
  "node:process",
  "process",
]);

const stringArrayOption = (options: Record<string, unknown>, key: string) => {
  const value = options[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
};

type AllowedPaths = {
  // Repository-relative files (or path suffixes) that own an env boundary.
  files: readonly string[];
  // Repository-relative directory prefixes of operational tooling that runs
  // outside any app env module (`apps/api/src/scripts/`).
  directories: readonly string[];
};

const isAllowedFile = (
  filename: string,
  { files, directories }: AllowedPaths,
): boolean =>
  DEFAULT_ALLOWED_FILE_PATTERNS.some((pattern) => pattern.test(filename)) ||
  files.some((file) => filename.endsWith(file.replaceAll("\\", "/"))) ||
  directories.some((directory) => filename.startsWith(directory));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export default eslintCompatPlugin({
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
              allowedDirectories: {
                type: "array",
                items: { type: "string" },
              },
            },
            additionalProperties: false,
          },
        ],
      },
      createOnce(context) {
        let checkImportMetaEnv = false;

        // A global binding: unresolved, or a built-in the scope manager
        // declares without a definition.
        const isGlobal = (node: unknown, name: string): boolean => {
          const expression = unwrapExpression(node);
          if (!isIdentifierReference(expression) || expression.name !== name) {
            return false;
          }
          const variable = resolveVariable(context, expression);
          return variable === null || variable.defs.length === 0;
        };

        // The `process` object: the global, `globalThis.process`, the
        // default or namespace import of `node:process`, or a stable alias.
        const isProcessObject = (
          node: unknown,
          seen = new Set<unknown>(),
        ): boolean => {
          const expression = unwrapExpression(node);
          if (!isAstNode(expression) || seen.has(expression)) {
            return false;
          }
          seen.add(expression);
          if (isGlobal(expression, "process")) {
            return true;
          }
          if (expression.type === "MemberExpression") {
            return (
              memberPropertyName(expression) === "process" &&
              isGlobal(expression.object, "globalThis")
            );
          }
          if (!isIdentifierReference(expression)) {
            return false;
          }
          const resolved = resolveImport(context, expression);
          if (resolved !== null) {
            return (
              PROCESS_MODULES.has(resolved.moduleId) &&
              (resolved.imported === "default" || resolved.imported === "*")
            );
          }
          const variable = resolveVariable(context, expression);
          const declarator = variable?.defs.at(0)?.node;
          const initializer =
            variable === null ? null : stableInitializer(variable);
          return (
            initializer !== null &&
            isAstNode(declarator) &&
            isIdentifier(declarator.id) &&
            isProcessObject(initializer, seen)
          );
        };

        // The label of the environment object `node` evaluates to, or null.
        const environmentObjectName = (node: unknown): string | null => {
          const expression = unwrapExpression(node);
          if (expression?.type !== "MemberExpression") {
            return null;
          }
          if (memberPropertyName(expression) !== "env") {
            return null;
          }
          if (isProcessObject(expression.object)) {
            return "process.env";
          }
          if (isGlobal(expression.object, "Bun")) {
            return "Bun.env";
          }
          const meta = unwrapExpression(expression.object);
          return checkImportMetaEnv &&
            meta?.type === "MetaProperty" &&
            isIdentifier(meta.meta, "import") &&
            isIdentifier(meta.property, "meta")
            ? "import.meta.env"
            : null;
        };

        const accessName = (base: string, member: unknown): string => {
          if (!isAstNode(member)) {
            return base;
          }
          const property = memberPropertyName(member);
          if (property === null) {
            return `${base}[...]`;
          }
          return member.computed === true
            ? `${base}[${JSON.stringify(property)}]`
            : `${base}.${property}`;
        };

        return {
          before() {
            const configured: unknown = context.options.at(0);
            const options = isRecord(configured) ? configured : {};
            const filename = repoRelativeFilename(context);
            checkImportMetaEnv = !VITE_CLIENT_ROOT.test(filename);
            return !isAllowedFile(filename, {
              files: stringArrayOption(options, "allowedFiles"),
              directories: stringArrayOption(options, "allowedDirectories"),
            });
          },
          MemberExpression(node) {
            const objectName = environmentObjectName(node.object);
            if (objectName !== null) {
              context.report({
                node,
                messageId: "processEnv",
                data: { envName: accessName(objectName, node) },
              });
              return;
            }
            const ownName = environmentObjectName(node);
            const parent = node.parent;
            if (
              ownName === null ||
              (isAstNode(parent) &&
                parent.type === "MemberExpression" &&
                parent.object === node)
            ) {
              return;
            }
            context.report({
              node,
              messageId: "processEnv",
              data: { envName: ownName },
            });
          },
          // `const { env } = process` binds the environment object itself.
          VariableDeclarator(node) {
            if (
              !isAstNode(node.id) ||
              node.id.type !== "ObjectPattern" ||
              !isProcessObject(node.init)
            ) {
              return;
            }
            for (const property of node.id.properties) {
              if (
                isAstNode(property) &&
                property.type === "Property" &&
                (!property.computed || isStringLiteral(property.key)) &&
                getPropertyName(property.key) === "env"
              ) {
                context.report({
                  node: property,
                  messageId: "processEnv",
                  data: { envName: "process.env" },
                });
              }
            }
          },
          // `import { env } from "node:process"`.
          ImportDeclaration(node) {
            if (
              typeof node.source.value !== "string" ||
              !PROCESS_MODULES.has(node.source.value)
            ) {
              return;
            }
            for (const specifier of node.specifiers) {
              if (getImportedName(specifier) === "env") {
                context.report({
                  node: specifier,
                  messageId: "processEnv",
                  data: { envName: "process.env" },
                });
              }
            }
          },
        };
      },
    },
  },
});
