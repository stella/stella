import { Result, TaggedError } from "better-result";
import { readFileSync, realpathSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import ts from "typescript";

import { repoRelativePath } from "@stll/portable-path";

import {
  SOURCE_FILE,
  lexShell,
  parseBunFlags,
  programWords,
} from "./install-free-ci";
import { parseSource } from "./parse-memo";
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
export type OfflineCheckCommand = { command: string } & (
  | { protected: true; entry: string }
  | { protected: false }
);
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
        const entry =
          words.at(0) === "bun"
            ? (offlineCheckEntry(words, root) ?? packageCheckEntry(words))
            : undefined;
        const command = JSON.stringify(words);
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

const importCapability = (file: string, capability: string) =>
  `${file}:${capability}`;

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
const isRawFetchCall = (node: ts.Node): boolean => {
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isCallExpression(node.parent) &&
    node.parent.expression === node
  ) {
    return false;
  }
  const expression = ts.isCallExpression(node) ? node.expression : node;
  if (ts.isIdentifier(expression)) {
    return (
      ts.isCallExpression(node) &&
      ["fetch", "fetchWithTimeout"].includes(expression.text)
    );
  }
  return (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === "fetch" &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "globalThis"
  );
};

const forbiddenBunMembers = new Set([
  "fetch",
  "connect",
  "listen",
  "spawn",
  "spawnSync",
]);
const isBunGlobal = (node: ts.Expression): boolean => {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    return isBunGlobal(node.expression);
  }
  return (
    (ts.isIdentifier(node) && node.text === "Bun") ||
    (ts.isPropertyAccessExpression(node) &&
      node.name.text === "Bun" &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "globalThis")
  );
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
  const pending = [...entries];
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
    const resolvedEntry = Result.try(() => realpathSync(candidate));
    if (resolvedEntry.isErr()) {
      violation(candidate, "Cannot read offline check source");
      continue;
    }
    const file = resolvedEntry.value;
    if (visited.has(file) || file.endsWith(".json")) {
      continue;
    }
    visited.add(file);
    const source = parseSource({
      fileName: file,
      text: readFileSync(file, "utf-8"),
    });
    const follow = (specifier: string) => {
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
        relative.split(path.sep).includes("node_modules")
      ) {
        return;
      }
      pending.push(resolved.value);
    };
    const visit = (node: ts.Node): void => {
      if (isRawFetchCall(node)) {
        classify(
          file,
          "fetch",
          "Raw fetch must remain in the snapshot transport owner",
        );
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        isBunGlobal(node.expression) &&
        forbiddenBunMembers.has(node.name.text)
      ) {
        classify(
          file,
          `Bun.${node.name.text}`,
          `Bun.${node.name.text} is forbidden`,
        );
      }
      if (ts.isElementAccessExpression(node) && isBunGlobal(node.expression)) {
        violation(file, "Computed access on Bun is forbidden");
      }
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        isBunGlobal(node.initializer)
      ) {
        // Aliasing or destructuring the global would hide transport member references.
        violation(file, "Aliasing the Bun global is forbidden");
      }
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier) &&
        !(
          ts.isImportDeclaration(node) &&
          node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword
        ) &&
        !(ts.isExportDeclaration(node) && node.isTypeOnly)
      ) {
        follow(node.moduleSpecifier.text);
      }
      if (
        ts.isImportEqualsDeclaration(node) &&
        !node.isTypeOnly &&
        ts.isExternalModuleReference(node.moduleReference)
      ) {
        const target = node.moduleReference.expression;
        if (ts.isStringLiteralLike(target)) {
          follow(target.text);
        } else {
          violation(file, "Dynamic module target cannot be enumerated");
        }
      }
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "require"))
      ) {
        const target = node.arguments.at(0);
        if (target && ts.isStringLiteralLike(target)) {
          follow(target.text);
        } else {
          violation(file, "Dynamic module target cannot be enumerated");
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
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
    ...offlineImportGraphViolations({
      entries: checks.flatMap((check) =>
        check.protected ? [check.entry] : [],
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
