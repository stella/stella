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
//
// `runtime-mode-keys` confines NODE_ENV and STELLA_LOCAL_DEV further, to the
// runtime mode owner, even inside files the rule above allows: local
// development capabilities depend on one resolution of the two keys, not on
// each reader's own. `import { env } from "bun"` and `globalThis.Bun.env`
// count as the environment object for both rules. It also follows aliases of the environment object
// (`const runtimeEnv = process.env; runtimeEnv.NODE_ENV`).

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  type AstNode,
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

const BUN_MODULE = "bun";

// Modules whose named `env` export is the environment object.
const ENV_EXPORTING_MODULES: ReadonlySet<string> = new Set([
  ...PROCESS_MODULES,
  BUN_MODULE,
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

// The one module that reads the runtime mode keys.
const RUNTIME_MODE_OWNER = "packages/runtime-mode/src/index.ts";
const RUNTIME_MODE_KEYS: ReadonlySet<string> = new Set([
  "NODE_ENV",
  "STELLA_LOCAL_DEV",
]);

type EnvironmentContext = Parameters<typeof resolveImport>[0];

const PATTERN_SOURCE = {
  environment: "environment",
  environmentHolder: "environment-holder",
  other: "other",
} as const;

type PatternSource = (typeof PATTERN_SOURCE)[keyof typeof PATTERN_SOURCE];

// `{ NODE_ENV = "x" }` binds through an AssignmentPattern.
const unwrapPatternDefault = (node: unknown): unknown =>
  isAstNode(node) && node.type === "AssignmentPattern" ? node.left : node;

type EnvironmentMatcherOptions = {
  context: EnvironmentContext;
  // Read at visit time: `before()` decides it per file.
  checkImportMetaEnv: () => boolean;
};

// Recognises the `process` object and the environment object in every
// spelling both rules below care about.
const createEnvironmentMatcher = ({
  context,
  checkImportMetaEnv,
}: EnvironmentMatcherOptions) => {
  // A global binding: unresolved, or a built-in the scope manager declares
  // without a definition.
  const isGlobal = (node: unknown, name: string): boolean => {
    const expression = unwrapExpression(node);
    if (!isIdentifierReference(expression) || expression.name !== name) {
      return false;
    }
    const variable = resolveVariable(context, expression);
    return variable === null || variable.defs.length === 0;
  };

  // The `process` object: the global, `globalThis.process`, the default or
  // namespace import of `node:process`, or a stable alias.
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
    const initializer = variable === null ? null : stableInitializer(variable);
    return (
      initializer !== null &&
      isAstNode(declarator) &&
      isIdentifier(declarator.id) &&
      isProcessObject(initializer, seen)
    );
  };

  // The `Bun` object: the global, `globalThis.Bun`, or the default or
  // namespace import of `bun`.
  const isBunObject = (node: unknown): boolean => {
    const expression = unwrapExpression(node);
    if (!isAstNode(expression)) {
      return false;
    }
    if (isGlobal(expression, "Bun")) {
      return true;
    }
    if (expression.type === "MemberExpression") {
      return (
        memberPropertyName(expression) === "Bun" &&
        isGlobal(expression.object, "globalThis")
      );
    }
    if (!isIdentifierReference(expression)) {
      return false;
    }
    const resolved = resolveImport(context, expression);
    return (
      resolved?.moduleId === BUN_MODULE &&
      (resolved.imported === "default" || resolved.imported === "*")
    );
  };

  // An object whose `env` property is the environment object.
  const isEnvironmentHolder = (node: unknown): boolean =>
    isProcessObject(node) || isBunObject(node);

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
    if (isBunObject(expression.object)) {
      return "Bun.env";
    }
    const meta = unwrapExpression(expression.object);
    return checkImportMetaEnv() &&
      meta?.type === "MetaProperty" &&
      isIdentifier(meta.meta, "import") &&
      isIdentifier(meta.property, "meta")
      ? "import.meta.env"
      : null;
  };

  // `const { env } = process` binding `name`.
  const destructuresEnvFromProcess = (
    declarator: AstNode,
    name: string,
  ): boolean =>
    isAstNode(declarator.id) &&
    declarator.id.type === "ObjectPattern" &&
    isEnvironmentHolder(declarator.init) &&
    Array.isArray(declarator.id.properties) &&
    declarator.id.properties.some(
      (property) =>
        isAstNode(property) &&
        property.type === "Property" &&
        getPropertyName(property.key) === "env" &&
        isIdentifier(property.value, name),
    );

  // The environment object itself, or a stable alias of it: an identifier
  // bound to `process.env`, to `import { env } from "node:process"`, or to
  // `const { env } = process`.
  const isEnvironmentObject = (
    node: unknown,
    seen = new Set<unknown>(),
  ): boolean => {
    const expression = unwrapExpression(node);
    if (!isAstNode(expression) || seen.has(expression)) {
      return false;
    }
    seen.add(expression);
    if (environmentObjectName(expression) !== null) {
      return true;
    }
    if (!isIdentifierReference(expression)) {
      return false;
    }
    const resolved = resolveImport(context, expression);
    if (resolved !== null) {
      return (
        ENV_EXPORTING_MODULES.has(resolved.moduleId) &&
        resolved.imported === "env"
      );
    }
    const variable = resolveVariable(context, expression);
    const declarator = variable?.defs.at(0)?.node;
    if (
      variable === null ||
      !isAstNode(declarator) ||
      declarator.type !== "VariableDeclarator"
    ) {
      return false;
    }
    if (destructuresEnvFromProcess(declarator, expression.name)) {
      return true;
    }
    const initializer = stableInitializer(variable);
    return (
      initializer !== null &&
      isIdentifier(declarator.id) &&
      isEnvironmentObject(initializer, seen)
    );
  };

  return {
    environmentObjectName,
    isBunObject,
    isEnvironmentHolder,
    isEnvironmentObject,
    isProcessObject,
  };
};

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
        const { environmentObjectName, isBunObject, isEnvironmentHolder } =
          createEnvironmentMatcher({
            context,
            checkImportMetaEnv: () => checkImportMetaEnv,
          });

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
              !isEnvironmentHolder(node.init)
            ) {
              return;
            }
            const envName = isBunObject(node.init) ? "Bun.env" : "process.env";
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
                  data: { envName },
                });
              }
            }
          },
          // `import { env } from "node:process"`, `import { env } from "bun"`.
          ImportDeclaration(node) {
            const source = node.source.value;
            if (
              typeof source !== "string" ||
              !ENV_EXPORTING_MODULES.has(source)
            ) {
              return;
            }
            const envName = source === BUN_MODULE ? "Bun.env" : "process.env";
            for (const specifier of node.specifiers) {
              if (getImportedName(specifier) === "env") {
                context.report({
                  node: specifier,
                  messageId: "processEnv",
                  data: { envName },
                });
              }
            }
          },
        };
      },
    },
    "runtime-mode-keys": {
      meta: {
        type: "problem",
        messages: {
          runtimeModeKey:
            "{{key}} is read only by @stll/runtime-mode; use the resolved runtime mode instead.",
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
      createOnce(context) {
        let checkImportMetaEnv = false;
        const { isEnvironmentHolder, isEnvironmentObject } =
          createEnvironmentMatcher({
            context,
            checkImportMetaEnv: () => checkImportMetaEnv,
          });

        // What a destructuring pattern reads from: the environment object
        // itself, or an object whose `env` property is one.
        const sourceOf = (node: unknown): PatternSource => {
          if (isEnvironmentObject(node)) {
            return PATTERN_SOURCE.environment;
          }
          return isEnvironmentHolder(node)
            ? PATTERN_SOURCE.environmentHolder
            : PATTERN_SOURCE.other;
        };

        // One walker for declaration and assignment destructuring: follows
        // `env` out of a process or Bun object, through defaults, and reports
        // each runtime mode key read from the environment object.
        const reportPattern = (pattern: unknown, source: PatternSource) => {
          const target = unwrapPatternDefault(pattern);
          if (
            source === PATTERN_SOURCE.other ||
            !isAstNode(target) ||
            target.type !== "ObjectPattern" ||
            !Array.isArray(target.properties)
          ) {
            return;
          }
          for (const property of target.properties) {
            if (
              !isAstNode(property) ||
              property.type !== "Property" ||
              (property.computed === true && !isStringLiteral(property.key))
            ) {
              continue;
            }
            const key = getPropertyName(property.key);
            if (source === PATTERN_SOURCE.environmentHolder) {
              if (key === "env") {
                reportPattern(property.value, PATTERN_SOURCE.environment);
              }
              continue;
            }
            if (key !== null && RUNTIME_MODE_KEYS.has(key)) {
              context.report({
                node: property,
                messageId: "runtimeModeKey",
                data: { key },
              });
            }
          }
        };

        return {
          before() {
            const configured: unknown = context.options.at(0);
            const options = isRecord(configured) ? configured : {};
            const filename = repoRelativeFilename(context);
            checkImportMetaEnv = !VITE_CLIENT_ROOT.test(filename);
            return ![
              RUNTIME_MODE_OWNER,
              ...stringArrayOption(options, "allowedFiles"),
            ].some((file) => filename.endsWith(file));
          },
          MemberExpression(node) {
            const key = isAstNode(node) ? memberPropertyName(node) : null;
            if (
              key === null ||
              !RUNTIME_MODE_KEYS.has(key) ||
              !isEnvironmentObject(node.object)
            ) {
              return;
            }
            context.report({
              node,
              messageId: "runtimeModeKey",
              data: { key },
            });
          },
          // `const { NODE_ENV } = process.env`,
          // `const { env: { STELLA_LOCAL_DEV } } = process`.
          VariableDeclarator(node) {
            reportPattern(node.id, sourceOf(node.init));
          },
          // `({ NODE_ENV } = process.env)`.
          AssignmentExpression(node) {
            reportPattern(node.left, sourceOf(node.right));
          },
        };
      },
    },
  },
});
