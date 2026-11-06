import { Result, TaggedError } from "better-result";
import { readFileSync, realpathSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";

import {
  type Expression,
  type Node,
  walk,
} from "../packages/scripts/src/syntax-tree";
import {
  lexShell,
  parseBunFlags,
  programWords,
  SOURCE_FILE,
} from "./install-free-ci";
import { parseSyntax } from "./parse-memo";
import { flattenWorkflowSteps } from "./workflow-steps";

export class OfflineCheckPolicyError extends TaggedError(
  "OfflineCheckPolicyError",
)<{
  message: string;
}> {}

export type OfflineCheckException = { command: string; reason: string };
export type OfflineImportAllowance = {
  capability: string;
  file: string;
  reason: string;
};
// `entry` is the script whose import closure must stay transport-safe, or
// null for Bun's native subcommands (`bun fmt`), which run no repository code
// and open no connection.
export type OfflineCheckCommand = { command: string } & (
  { protected: true; entry: string | null } | { protected: false }
);
export type OfflineCheckCallerSource = {
  file: string;
  source: string;
  type: "package" | "test" | "turbo" | "workflow";
};
const root = path.resolve(import.meta.dir, "..");
const preload = path.join(root, "scripts/offline-network-preload.ts");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const offlineCheckEntry = (words: readonly string[], cwd: string) => {
  if (words.at(0) !== "bun") {
    return undefined;
  }
  const relativeCwd = repoRelativePath(root, cwd);
  const invocation = parseBunFlags({
    args: words.slice(1),
    context: { root, expanding: new Set(), checkouts: [] },
    cwd: relativeCwd,
    stdin: undefined,
  });
  if (invocation.type !== "parsed") {
    return undefined;
  }
  const entry = invocation.positional.at(0);
  // Package scripts launch their own process; verify its command separately.
  if (
    entry === undefined ||
    invocation.filter !== undefined ||
    invocation.dir !== relativeCwd ||
    !SOURCE_FILE.test(entry) ||
    !invocation.preloads.some(
      (target) => path.resolve(root, target) === preload,
    )
  ) {
    return undefined;
  }
  return path.resolve(cwd, entry);
};

export const usesOfflineCheckPreload = (
  words: readonly string[],
  cwd: string,
) => offlineCheckEntry(words, cwd) !== undefined;

const directCheckEntry = (words: readonly string[], cwd: string) => {
  if (words.at(0) !== "bun") {
    return undefined;
  }
  const relativeCwd = repoRelativePath(root, cwd);
  const invocation = parseBunFlags({
    args: words.slice(1),
    context: { root, expanding: new Set(), checkouts: [] },
    cwd: relativeCwd,
    stdin: undefined,
  });
  if (invocation.type !== "parsed" || invocation.filter !== undefined) {
    return undefined;
  }
  const entry = invocation.positional.at(0);
  return entry === undefined || !SOURCE_FILE.test(entry)
    ? undefined
    : path.resolve(cwd, entry);
};

const sourceLine = (source: string, offset: number) =>
  source.slice(0, offset).split("\n").length;

/** Find direct protected-check callers outside the workflow-only policy inventory. */
export const protectedOfflineCheckCallerViolations = (
  protectedEntries: readonly string[],
  sources: readonly OfflineCheckCallerSource[],
): string[] => {
  const protectedPaths = new Set(
    protectedEntries.map((entry) => path.resolve(entry)),
  );
  const violations: string[] = [];
  const report = (file: string, line: number) =>
    violations.push(
      `${file}:${line}: protected offline check must use the network preload; add \`--preload ./scripts/offline-network-preload.ts\` before the entry`,
    );
  const inspectShell = (
    file: string,
    commandSource: string,
    cwd: string,
    fileSource: string,
  ) => {
    for (const event of lexShell(commandSource)) {
      if (event.type !== "command" || !event.words.includes("--check")) {
        continue;
      }
      const words = programWords(event.words);
      const entry = directCheckEntry(words, cwd);
      if (
        entry !== undefined &&
        protectedPaths.has(entry) &&
        !usesOfflineCheckPreload(words, cwd)
      ) {
        const offset = fileSource.indexOf(commandSource);
        report(file, offset === -1 ? 1 : sourceLine(fileSource, offset));
      }
    }
  };
  for (const { file, source, type } of sources) {
    const absoluteFile = path.resolve(root, file);
    const cwd = type === "package" ? path.dirname(absoluteFile) : root;
    if (type === "package") {
      const manifest: unknown = JSON.parse(source);
      if (!isRecord(manifest) || !isRecord(manifest["scripts"])) {
        continue;
      }
      for (const command of Object.values(manifest["scripts"])) {
        if (typeof command === "string") {
          inspectShell(file, command, cwd, source);
        }
      }
      continue;
    }
    if (type === "workflow") {
      const workflow: unknown = Bun.YAML.parse(source);
      if (!isRecord(workflow) || !isRecord(workflow["jobs"])) {
        continue;
      }
      for (const job of Object.values(workflow["jobs"])) {
        if (!isRecord(job) || job["steps"] === undefined) {
          continue;
        }
        for (const step of flattenWorkflowSteps(job["steps"])) {
          if (typeof step["run"] === "string") {
            inspectShell(file, step["run"], root, source);
          }
        }
      }
      continue;
    }
    if (type === "turbo") {
      const visit = (value: unknown): void => {
        if (typeof value === "string") {
          inspectShell(file, value, root, source);
        } else if (Array.isArray(value)) {
          for (const entry of value) {
            visit(entry);
          }
        } else if (isRecord(value)) {
          for (const entry of Object.values(value)) {
            visit(entry);
          }
        }
      };
      visit(Bun.JSONC.parse(source));
      continue;
    }
    if (
      !source.includes('"--check"') ||
      ![...protectedPaths].some((entry) =>
        source.includes(path.basename(entry)),
      )
    ) {
      continue;
    }
    const parsed = parseSyntax({ fileName: absoluteFile, text: source });
    walk(parsed.program, (node) => {
      if (
        node.type !== "CallExpression" ||
        node.callee.type !== "MemberExpression" ||
        node.callee.computed ||
        node.callee.object.type !== "Identifier" ||
        node.callee.object.name !== "Bun" ||
        node.callee.property.type !== "Identifier" ||
        !["spawn", "spawnSync"].includes(node.callee.property.name)
      ) {
        return;
      }
      const call = source.slice(node.start, node.end);
      const callsProtected = [...protectedPaths].some((entry) =>
        call.includes(path.basename(entry)),
      );
      if (
        callsProtected &&
        call.includes('"--check"') &&
        !call.includes("offline-network-preload.ts")
      ) {
        report(file, sourceLine(source, node.start));
      }
    });
  }
  return violations;
};

export const trackedOfflineCheckCallerSources =
  (): OfflineCheckCallerSource[] => {
    const tracked = Bun.spawnSync(
      [
        "git",
        "ls-files",
        "-z",
        "package.json",
        "apps/*/package.json",
        "packages/*/package.json",
        "turbo.json",
        ".github/workflows/*.yml",
        "*.test.ts",
        "scripts/*.test.ts",
        "apps/**/*.test.ts",
        "packages/**/*.test.ts",
      ],
      { cwd: root },
    );
    if (tracked.exitCode !== 0) {
      throw new OfflineCheckPolicyError({
        message: "Cannot enumerate offline check callers",
      });
    }
    return tracked.stdout
      .toString()
      .split("\0")
      .filter(Boolean)
      .map((file) => {
        let type: OfflineCheckCallerSource["type"] = "test";
        if (file.endsWith("package.json")) {
          type = "package";
        } else if (file === "turbo.json") {
          type = "turbo";
        } else if (file.startsWith(".github/workflows/")) {
          type = "workflow";
        }
        return {
          file,
          source: readFileSync(path.join(root, file), "utf-8"),
          type,
        };
      });
  };

const packageCheckEntry = (words: readonly string[]) => {
  const invocation = parseBunFlags({
    args: words.slice(1),
    context: { root, expanding: new Set(), checkouts: [] },
    cwd: "",
    stdin: undefined,
  });
  if (invocation.type !== "parsed") {
    return undefined;
  }
  const name = invocation.filter;
  const script = invocation.positional.at(0);
  if (name === undefined || script === undefined || invocation.dir !== "") {
    return undefined;
  }
  for (const file of new Bun.Glob("{apps,packages}/*/package.json").scanSync({
    cwd: root,
  })) {
    const manifest: unknown = JSON.parse(
      readFileSync(path.join(root, file), "utf-8"),
    );
    if (
      !isRecord(manifest) ||
      manifest["name"] !== name ||
      !isRecord(manifest["scripts"])
    ) {
      continue;
    }
    const command = manifest["scripts"][script];
    if (typeof command !== "string") {
      return undefined;
    }
    const commands = lexShell(command).filter(
      (event) => event.type === "command",
    );
    const commandEntry = commands.at(0);
    if (commands.length !== 1 || commandEntry === undefined) {
      return undefined;
    }
    return offlineCheckEntry(
      programWords(commandEntry.words),
      path.dirname(path.join(root, file)),
    );
  }
  return undefined;
};

const NATIVE_OFFLINE_SUBCOMMANDS: ReadonlySet<string> = new Set(["fmt"]);

/** Enumerate every check invocation, including shell substitutions and parallel groups. */
export const enumerateOfflineChecks = (
  workflow: unknown,
): OfflineCheckCommand[] => {
  if (!isRecord(workflow) || !isRecord(workflow["jobs"])) {
    throw new OfflineCheckPolicyError({ message: "Workflow jobs are missing" });
  }
  const checks: OfflineCheckCommand[] = [];
  for (const job of Object.values(workflow["jobs"])) {
    if (!isRecord(job) || job["steps"] === undefined) {
      continue;
    }
    for (const step of flattenWorkflowSteps(job["steps"])) {
      if (typeof step["run"] !== "string") {
        continue;
      }
      for (const event of lexShell(step["run"])) {
        if (event.type !== "command" || !event.words.includes("--check")) {
          continue;
        }
        const words = programWords(event.words);
        const command = JSON.stringify(words);
        if (
          words.at(0) === "bun" &&
          NATIVE_OFFLINE_SUBCOMMANDS.has(words.at(1) ?? "")
        ) {
          checks.push({ command, protected: true, entry: null });
          continue;
        }
        const entry =
          words.at(0) === "bun"
            ? (offlineCheckEntry(words, root) ?? packageCheckEntry(words))
            : undefined;
        checks.push(
          entry === undefined
            ? { command, protected: false }
            : { command, protected: true, entry },
        );
      }
    }
  }
  return checks;
};

export const parseOfflineCheckExceptions = (
  value: unknown,
): OfflineCheckException[] => {
  if (!Array.isArray(value)) {
    throw new OfflineCheckPolicyError({
      message: "Offline check exceptions must be an array",
    });
  }
  return value.map((entry: unknown) => {
    if (
      !isRecord(entry) ||
      typeof entry["command"] !== "string" ||
      typeof entry["reason"] !== "string" ||
      entry["reason"].trim() === ""
    ) {
      throw new OfflineCheckPolicyError({
        message: "Every offline check exception needs a command and reason",
      });
    }
    return { command: entry["command"], reason: entry["reason"] };
  });
};

export const offlineCheckViolations = (
  checks: readonly { command: string; protected: boolean }[],
  exceptions: readonly OfflineCheckException[],
): string[] => {
  const violations: string[] = [];
  const workflowExceptions = exceptions.filter(
    ({ command }) => !command.startsWith("source:"),
  );
  const allowed = new Set(workflowExceptions.map(({ command }) => command));
  if (allowed.size !== workflowExceptions.length) {
    violations.push("Duplicate offline check exception");
  }
  const raw = new Set(
    checks.filter((check) => !check.protected).map(({ command }) => command),
  );
  for (const command of raw) {
    if (!allowed.has(command)) {
      violations.push(`Check must use the offline network preload: ${command}`);
    }
  }
  for (const command of allowed) {
    if (!raw.has(command)) {
      violations.push(`Stale offline check exception: ${command}`);
    }
  }
  return violations;
};

export const offlineCheckStartupViolations = (
  entries: readonly string[],
): string[] => {
  const violations: string[] = [];
  for (const entry of new Set(entries)) {
    const parsed = parseSyntax({
      fileName: entry,
      text: readFileSync(entry, "utf-8"),
    });
    const bindings = new Set<string>();
    for (const statement of parsed.program.body) {
      if (
        statement.type !== "ImportDeclaration" ||
        statement.importKind === "type"
      ) {
        continue;
      }
      const resolved = Result.try(() =>
        realpathSync(
          Bun.resolveSync(statement.source.value, path.dirname(entry)),
        ),
      );
      if (
        resolved.isErr() ||
        ![
          path.join(root, "scripts/offline-check-startup.ts"),
          path.join(root, "packages/scripts/src/offline-check-startup.ts"),
        ].includes(resolved.value)
      ) {
        continue;
      }
      for (const binding of statement.specifiers) {
        if (
          binding.type === "ImportSpecifier" &&
          binding.importKind !== "type" &&
          (binding.imported.type === "Identifier"
            ? binding.imported.name
            : binding.imported.value) === "assertOfflineCheckPreload"
        ) {
          bindings.add(binding.local.name);
        }
      }
    }
    const isGuardCall = (statement: Node | undefined) =>
      statement?.type === "ExpressionStatement" &&
      statement.expression.type === "CallExpression" &&
      !statement.expression.optional &&
      statement.expression.callee.type === "Identifier" &&
      bindings.has(statement.expression.callee.name);
    const declarationOnly = new Set([
      "TSTypeAliasDeclaration",
      "TSInterfaceDeclaration",
      "FunctionDeclaration",
    ]);
    const firstExecutable = parsed.program.body.find((statement) => {
      if (statement.type === "ExportNamedDeclaration") {
        return (
          statement.declaration !== null &&
          !declarationOnly.has(statement.declaration.type)
        );
      }
      return (
        statement.type !== "ImportDeclaration" &&
        statement.type !== "ExportAllDeclaration" &&
        !declarationOnly.has(statement.type)
      );
    });
    const namesGuard = (node: Node): boolean => {
      if (node.type === "Identifier") {
        return bindings.has(node.name);
      }
      if (node.type === "ObjectPattern") {
        return node.properties.some((property) =>
          property.type === "RestElement"
            ? namesGuard(property.argument)
            : namesGuard(property.value),
        );
      }
      if (node.type === "ArrayPattern") {
        return node.elements.some(
          (element) => element !== null && namesGuard(element),
        );
      }
      if (node.type === "AssignmentPattern") {
        return namesGuard(node.left);
      }
      if (node.type === "RestElement") {
        return namesGuard(node.argument);
      }
      return false;
    };
    const shadowsGuard = (child: Node): boolean => {
      if (child.type === "VariableDeclaration") {
        return child.declarations.some(({ id }) => namesGuard(id));
      }
      if (
        child.type === "FunctionDeclaration" ||
        child.type === "ClassDeclaration"
      ) {
        return child.id !== null && bindings.has(child.id.name);
      }
      if (child.type === "TSEnumDeclaration") {
        return bindings.has(child.id.name);
      }
      if (child.type === "TSModuleDeclaration") {
        return child.id.type === "Identifier" && bindings.has(child.id.name);
      }
      return false;
    };
    const calledAtStartup = parsed.program.body.some((statement) => {
      if (statement === firstExecutable && isGuardCall(statement)) {
        return true;
      }
      if (
        statement.type !== "IfStatement" ||
        statement.test.type !== "MemberExpression" ||
        statement.test.computed ||
        statement.test.property.type !== "Identifier" ||
        statement.test.property.name !== "main" ||
        statement.test.object.type !== "MetaProperty" ||
        statement.test.object.meta.name !== "import" ||
        statement.test.object.property.name !== "meta"
      ) {
        return false;
      }
      if (
        statement.consequent.type === "BlockStatement" &&
        statement.consequent.body.some(shadowsGuard)
      ) {
        return false;
      }
      // A check's guarded main branch starts with the assertion itself.
      // Calls in dormant helpers or unrelated conditionals prove no startup.
      return isGuardCall(
        statement.consequent.type === "BlockStatement"
          ? statement.consequent.body.at(0)
          : statement.consequent,
      );
    });
    if (!calledAtStartup) {
      violations.push(
        `Offline check entry must assert the preload at startup: ${repoRelativePath(root, entry)}`,
      );
    }
  }
  return violations;
};

export const bunfigRuntimePreloadViolations = (
  bunfigs: ReadonlyMap<string, string>,
): string[] => {
  const violations: string[] = [];
  for (const [file, source] of bunfigs) {
    const parsed: unknown = Bun.TOML.parse(source);
    if (isRecord(parsed) && "preload" in parsed) {
      violations.push(
        `Tracked bunfig must not declare a top-level runtime preload: ${file}`,
      );
    }
  }
  return violations;
};

const importCapability = (file: string, capability: string) =>
  `${file}:${capability}`;
const INERT_IMPORT_EXTENSIONS: ReadonlySet<string> = new Set([
  ".json",
  ".text",
  ".txt",
]);
type ImportLoader =
  | { type: "default" }
  | { type: "loader"; loader: string }
  | { type: "unsupported" };
const DEFAULT_IMPORT_LOADER = { type: "default" } as const;

export const parseOfflineImportAllowances = (
  value: unknown,
): OfflineImportAllowance[] => {
  if (!Array.isArray(value)) {
    throw new OfflineCheckPolicyError({
      message: "Offline import allowances must be an array",
    });
  }
  return value.map((entry: unknown) => {
    if (
      !isRecord(entry) ||
      typeof entry["capability"] !== "string" ||
      typeof entry["file"] !== "string" ||
      typeof entry["reason"] !== "string"
    ) {
      throw new OfflineCheckPolicyError({
        message:
          "Every offline import allowance needs a file, capability, and reason",
      });
    }
    return {
      capability: entry["capability"],
      file: entry["file"],
      reason: entry["reason"],
    };
  });
};
const isRawFetchCall = (node: Node, parent: Node | undefined): boolean => {
  if (
    node.type === "MemberExpression" &&
    !node.computed &&
    parent?.type === "CallExpression" &&
    parent.callee === node
  ) {
    return false;
  }
  const expression = node.type === "CallExpression" ? node.callee : node;
  if (expression.type === "Identifier") {
    return (
      node.type === "CallExpression" &&
      ["fetch", "fetchWithTimeout"].includes(expression.name)
    );
  }
  return (
    expression.type === "MemberExpression" &&
    !expression.computed &&
    expression.property.type === "Identifier" &&
    expression.property.name === "fetch" &&
    expression.object.type === "Identifier" &&
    expression.object.name === "globalThis"
  );
};

const forbiddenBunMembers = new Set([
  "fetch",
  "connect",
  "listen",
  "spawn",
  "spawnSync",
]);
const isBunGlobal = (node: Expression): boolean => {
  // An optional chain (`globalThis?.Bun`) is wrapped as a whole.
  if (
    node.type === "ParenthesizedExpression" ||
    node.type === "ChainExpression" ||
    node.type === "TSAsExpression" ||
    node.type === "TSNonNullExpression"
  ) {
    return isBunGlobal(node.expression);
  }
  return (
    (node.type === "Identifier" && node.name === "Bun") ||
    (node.type === "MemberExpression" &&
      !node.computed &&
      node.property.type === "Identifier" &&
      node.property.name === "Bun" &&
      node.object.type === "Identifier" &&
      node.object.name === "globalThis")
  );
};

// A module specifier written as a string or a template without
// substitutions.
const literalText = (node: Node): string | undefined => {
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.at(0)?.value.cooked ?? undefined;
  }
  return undefined;
};
const propertyName = (node: Node): string | undefined =>
  node.type === "Identifier" ? node.name : literalText(node);
const staticImportLoader = (attributes: readonly Node[]): ImportLoader => {
  if (attributes.length === 0) {
    return DEFAULT_IMPORT_LOADER;
  }
  const attribute = attributes.at(0);
  if (
    attributes.length !== 1 ||
    attribute?.type !== "ImportAttribute" ||
    propertyName(attribute.key) !== "type"
  ) {
    return { type: "unsupported" };
  }
  const loader = literalText(attribute.value);
  return loader === undefined
    ? { type: "unsupported" }
    : { type: "loader", loader };
};
const dynamicImportLoader = (options: Node | null): ImportLoader => {
  if (options === null) {
    return DEFAULT_IMPORT_LOADER;
  }
  if (options.type !== "ObjectExpression" || options.properties.length !== 1) {
    return { type: "unsupported" };
  }
  const withProperty = options.properties.at(0);
  if (
    withProperty?.type !== "Property" ||
    withProperty.computed ||
    propertyName(withProperty.key) !== "with" ||
    withProperty.value.type !== "ObjectExpression" ||
    withProperty.value.properties.length !== 1
  ) {
    return { type: "unsupported" };
  }
  const typeProperty = withProperty.value.properties.at(0);
  if (
    typeProperty?.type !== "Property" ||
    typeProperty.computed ||
    propertyName(typeProperty.key) !== "type"
  ) {
    return { type: "unsupported" };
  }
  const loader = literalText(typeProperty.value);
  return loader === undefined
    ? { type: "unsupported" }
    : { type: "loader", loader };
};

type OfflineImportGraphOptions = {
  allowances?: readonly OfflineImportAllowance[];
  entries: readonly string[];
  repositoryRoot: string;
};
/** Inspect the local closure, including workspace packages resolved through symlinks. */
export const offlineImportGraphViolations = ({
  allowances = [],
  entries,
  repositoryRoot,
}: OfflineImportGraphOptions) => {
  const sourceRoot = realpathSync(repositoryRoot);
  const pending: { file: string; parserFile: string }[] = entries.map(
    (file) => ({ file, parserFile: file }),
  );
  const visited = new Set<string>();
  const violations: OfflineCheckPolicyError[] = [];
  const allowed = new Map(
    allowances.map(({ capability, file, reason }) => [
      importCapability(file, capability),
      reason,
    ]),
  );
  const exercised = new Set<string>();
  const violation = (file: string, detail: string) => {
    violations.push(
      new OfflineCheckPolicyError({
        message: `Offline check import graph: ${repoRelativePath(sourceRoot, file)}: ${detail}`,
      }),
    );
  };
  const classify = (file: string, capability: string, detail: string) => {
    const relative = repoRelativePath(sourceRoot, file);
    const key = importCapability(relative, capability);
    if (allowed.has(key)) {
      exercised.add(key);
      return;
    }
    violation(file, detail);
  };
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (candidate === undefined) {
      break;
    }
    const resolvedEntry = Result.try(() => realpathSync(candidate.file));
    if (resolvedEntry.isErr()) {
      violation(candidate.file, "Cannot read offline check source");
      continue;
    }
    const file = resolvedEntry.value;
    const visitKey = `${file}\0${candidate.parserFile}`;
    if (
      visited.has(visitKey) ||
      INERT_IMPORT_EXTENSIONS.has(path.extname(candidate.parserFile))
    ) {
      continue;
    }
    visited.add(visitKey);
    const source = parseSyntax({
      fileName: candidate.parserFile,
      text: readFileSync(file, "utf-8"),
    });
    const follow = (specifier: string, loader: ImportLoader) => {
      if (specifier === "node:child_process" || specifier === "child_process") {
        classify(file, "node:child_process", "node:child_process is forbidden");
        return;
      }
      if (
        isBuiltin(specifier) ||
        specifier === "bun" ||
        specifier.startsWith("bun:")
      ) {
        return;
      }
      const resolved = Result.try(() =>
        realpathSync(Bun.resolveSync(specifier, path.dirname(file))),
      );
      if (resolved.isErr()) {
        violation(file, `Cannot resolve import ${specifier}`);
        return;
      }
      const relative = repoRelativePath(sourceRoot, resolved.value);
      if (
        relative.startsWith("..") ||
        path.isAbsolute(relative) ||
        relative.split("/").includes("node_modules")
      ) {
        return;
      }
      if (loader.type === "unsupported") {
        classify(file, "dynamic-module", "Import loader cannot be enumerated");
        return;
      }
      pending.push({
        file: resolved.value,
        parserFile:
          loader.type === "default"
            ? resolved.value
            : `${resolved.value}.${loader.loader}`,
      });
    };
    const followTarget = (target: Node | undefined, loader: ImportLoader) => {
      const specifier = target === undefined ? undefined : literalText(target);
      if (specifier === undefined) {
        classify(
          file,
          "dynamic-module",
          "Dynamic module target cannot be enumerated",
        );
      } else {
        follow(specifier, loader);
      }
    };
    walk(source.program, (node, ancestors) => {
      if (isRawFetchCall(node, ancestors.at(-1))) {
        classify(
          file,
          "fetch",
          "Raw fetch must remain in the snapshot transport owner",
        );
      }
      if (
        node.type === "MemberExpression" &&
        !node.computed &&
        node.property.type === "Identifier" &&
        isBunGlobal(node.object) &&
        forbiddenBunMembers.has(node.property.name)
      ) {
        classify(
          file,
          `Bun.${node.property.name}`,
          `Bun.${node.property.name} is forbidden`,
        );
      }
      if (
        node.type === "MemberExpression" &&
        node.computed &&
        isBunGlobal(node.object)
      ) {
        violation(file, "Computed access on Bun is forbidden");
      }
      if (
        node.type === "VariableDeclarator" &&
        node.init &&
        isBunGlobal(node.init)
      ) {
        // Aliasing or destructuring the global would hide transport member references.
        violation(file, "Aliasing the Bun global is forbidden");
      }
      if (node.type === "ImportDeclaration" && node.importKind !== "type") {
        follow(node.source.value, staticImportLoader(node.attributes));
      }
      if (
        (node.type === "ExportNamedDeclaration" ||
          node.type === "ExportAllDeclaration") &&
        node.source &&
        node.exportKind !== "type"
      ) {
        follow(node.source.value, staticImportLoader(node.attributes));
      }
      if (
        node.type === "TSImportEqualsDeclaration" &&
        node.importKind !== "type" &&
        node.moduleReference.type === "TSExternalModuleReference"
      ) {
        followTarget(node.moduleReference.expression, DEFAULT_IMPORT_LOADER);
      }
      if (node.type === "ImportExpression") {
        followTarget(node.source, dynamicImportLoader(node.options));
      }
      if (
        node.type === "CallExpression" &&
        node.callee.type === "Identifier" &&
        node.callee.name === "require"
      ) {
        followTarget(node.arguments.at(0), DEFAULT_IMPORT_LOADER);
      }
    });
  }
  for (const [key, reason] of allowed) {
    if (reason.trim() === "") {
      violations.push(
        new OfflineCheckPolicyError({
          message: `Offline import allowance needs a reason: ${key}`,
        }),
      );
    } else if (!exercised.has(key)) {
      violations.push(
        new OfflineCheckPolicyError({
          message: `Stale offline import allowance: ${key}`,
        }),
      );
    }
  }
  return violations;
};

/** Catalog generators must share the snapshot owner rather than acquire live inputs. */
export const catalogGeneratorNetworkViolations = (
  sources: ReadonlyMap<string, string>,
  exceptions: readonly OfflineCheckException[],
): string[] => {
  const checks = [...sources].map(([file, source]) => ({
    command: file,
    protected:
      !/(?:\b(?:fetch|fetchWithTimeout)\s*\(|from\s+["'](?:@stll\/fetch|node:(?:http|https|net|tls))["'])/u.test(
        source,
      ),
  }));
  const sourceExceptions = exceptions.filter(({ command }) =>
    command.startsWith("source:"),
  );
  return offlineCheckViolations(
    checks,
    sourceExceptions.map(({ command, reason }) => ({
      command: command.slice(7),
      reason,
    })),
  ).map(
    (violation) =>
      `Catalog generator transport must be owned by model-catalog-snapshot.ts: ${violation}`,
  );
};

export const offlineCheckExceptionGrowth = (
  current: readonly OfflineCheckException[],
  baseline: readonly OfflineCheckException[],
): string[] => {
  const existing = new Set(
    baseline.map(({ command, reason }) => JSON.stringify({ command, reason })),
  );
  return current
    .filter((entry) => !existing.has(JSON.stringify(entry)))
    .map(
      ({ command }) => `Offline check exceptions may only shrink: ${command}`,
    );
};

if (import.meta.main) {
  const exceptions = parseOfflineCheckExceptions(
    JSON.parse(
      readFileSync(
        path.join(root, "scripts/offline-check-exceptions.json"),
        "utf-8",
      ),
    ),
  );
  const workflow: unknown = Bun.YAML.parse(
    readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf-8"),
  );
  const checks = enumerateOfflineChecks(workflow);
  const importAllowances = parseOfflineImportAllowances(
    JSON.parse(
      readFileSync(
        path.join(root, "scripts/offline-check-import-allowlist.json"),
        "utf-8",
      ),
    ),
  );
  const violations = offlineCheckViolations(checks, exceptions);
  violations.push(
    ...offlineCheckStartupViolations(
      checks.flatMap((check) =>
        check.protected && check.entry !== null ? [check.entry] : [],
      ),
    ),
  );
  violations.push(
    ...protectedOfflineCheckCallerViolations(
      checks.flatMap((check) =>
        check.protected && check.entry !== null ? [check.entry] : [],
      ),
      trackedOfflineCheckCallerSources(),
    ),
  );
  const trackedBunfigs = Bun.spawnSync(
    ["git", "ls-files", "-z", "*bunfig.toml"],
    { cwd: root },
  );
  if (trackedBunfigs.exitCode !== 0) {
    throw new OfflineCheckPolicyError({
      message: "Cannot enumerate tracked bunfig.toml files",
    });
  }
  violations.push(
    ...bunfigRuntimePreloadViolations(
      new Map(
        trackedBunfigs.stdout
          .toString()
          .split("\0")
          .filter(Boolean)
          .map((file) => [file, readFileSync(path.join(root, file), "utf-8")]),
      ),
    ),
  );
  violations.push(
    ...offlineImportGraphViolations({
      entries: checks.flatMap((check) =>
        check.protected && check.entry !== null ? [check.entry] : [],
      ),
      repositoryRoot: root,
      allowances: importAllowances,
    }).map((error) => error.message),
  );
  const sources = new Map(
    [
      ...new Bun.Glob("model-catalog-*-gen.ts").scanSync({
        cwd: path.join(root, "packages/scripts/src"),
      }),
    ].map((file) => [
      file,
      readFileSync(path.join(root, "packages/scripts/src", file), "utf-8"),
    ]),
  );
  violations.push(...catalogGeneratorNetworkViolations(sources, exceptions));
  const base = Bun.spawnSync(["git", "merge-base", "origin/main", "HEAD"], {
    cwd: root,
  });
  if (base.exitCode !== 0) {
    throw new OfflineCheckPolicyError({
      message: "Offline check baseline unavailable",
    });
  }
  const old = Bun.spawnSync(
    [
      "git",
      "show",
      `${base.stdout.toString().trim()}:scripts/offline-check-exceptions.json`,
    ],
    { cwd: root },
  );
  if (old.exitCode === 0) {
    violations.push(
      ...offlineCheckExceptionGrowth(
        exceptions,
        parseOfflineCheckExceptions(JSON.parse(old.stdout.toString())),
      ),
    );
  }
  for (const violation of violations) {
    console.error(violation);
  }
  if (violations.length > 0) {
    process.exitCode = 1;
  }
}
