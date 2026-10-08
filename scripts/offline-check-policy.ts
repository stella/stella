import { TaggedError } from "better-result";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  SOURCE_FILE,
  lexShell,
  parseBunFlags,
  programWords,
} from "./install-free-ci";
import { flattenWorkflowSteps } from "./workflow-steps";

class OfflineCheckPolicyError extends TaggedError("OfflineCheckPolicyError")<{
  message: string;
}> {}

export type OfflineCheckException = { command: string; reason: string };
export type OfflineCheckCommand = { command: string; protected: boolean };
const root = path.resolve(import.meta.dir, "..");
const preload = path.join(root, "scripts/offline-network-preload.ts");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const usesOfflineCheckPreload = (
  words: readonly string[],
  cwd: string,
) => {
  if (words.at(0) !== "bun") {
    return false;
  }
  const relativeCwd = path.relative(root, cwd);
  const invocation = parseBunFlags({
    args: words.slice(1),
    context: { root, expanding: new Set() },
    cwd: relativeCwd,
    stdin: undefined,
  });
  if (invocation.type !== "parsed") {
    return false;
  }
  const entry = invocation.positional.at(0);
  // Package scripts launch their own process; verify its command separately.
  return (
    invocation.filter === undefined &&
    invocation.dir === relativeCwd &&
    entry !== undefined &&
    SOURCE_FILE.test(entry) &&
    invocation.preloads.some((target) => path.resolve(root, target) === preload)
  );
};

const protectsPackageCommand = (words: readonly string[]) => {
  const invocation = parseBunFlags({
    args: words.slice(1),
    context: { root, expanding: new Set() },
    cwd: "",
    stdin: undefined,
  });
  if (invocation.type !== "parsed") {
    return false;
  }
  const name = invocation.filter;
  const script = invocation.positional.at(0);
  if (name === undefined || script === undefined || invocation.dir !== "") {
    return false;
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
      return false;
    }
    const commands = lexShell(command).filter(
      (event) => event.type === "command",
    );
    return (
      commands.length === 1 &&
      commands.every(({ words: packageWords }) =>
        usesOfflineCheckPreload(
          programWords(packageWords),
          path.dirname(path.join(root, file)),
        ),
      )
    );
  }
  return false;
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
        checks.push({
          command: JSON.stringify(words),
          protected:
            words.at(0) === "bun" &&
            (usesOfflineCheckPreload(words, root) ||
              protectsPackageCommand(words)),
        });
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
  checks: readonly OfflineCheckCommand[],
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
  const violations = offlineCheckViolations(
    enumerateOfflineChecks(workflow),
    exceptions,
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
