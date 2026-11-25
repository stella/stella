#!/usr/bin/env bun
// Fast local pre-push verifier for repo policy, snapshot, ledger, and rollout
// guards. Inspects changed files against the merge base and runs only the
// guards CI will enforce for those paths, surfacing exact fix commands in
// seconds instead of waiting for a full CI round-trip.

import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CHILD_MAX_BUFFER = 16 * 1024 * 1024;

export type PrGuard = {
  readonly id: string;
  readonly label: string;
  readonly command: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly fixHint: string;
};

const matchesAny = (
  files: readonly string[],
  predicate: (file: string) => boolean,
): boolean => files.some(predicate);

const isOxlintFile = (file: string): boolean =>
  file.startsWith(".oxlint-plugins/") ||
  file.startsWith("scripts/guard-rollouts/") ||
  /(?:^|\/)oxlint(?:\.[^./]+)*\.config\.(?:ts|js|json)$/u.test(file);

const isUiApiFile = (file: string): boolean =>
  file.startsWith("packages/ui/src/") ||
  file === "DESIGN.md" ||
  file === "scripts/ui-api-snapshot.json";

const isPublishedPackageSource = (file: string): boolean =>
  /^packages\/[^/]+\/(?:src\/|package\.json$|api-report\.json$)/u.test(file);

const isParserGuardFile = (file: string): boolean =>
  file.startsWith("apps/api/src/handlers/case-law/ingestion/") ||
  file.startsWith("apps/api/src/handlers/legislation/ingestion/") ||
  file.startsWith("apps/api/src/lib/legal-search/parsers/") ||
  file.startsWith("apps/api/src/lib/case-law/") ||
  file.startsWith("packages/legal-ast/");

const isDesignBaselineScope = (file: string): boolean =>
  file.startsWith("apps/") ||
  file.startsWith("packages/") ||
  file.startsWith(".claude/mcp/") ||
  file === "scripts/design-lint-baseline.json";

const isScriptTestFile = (file: string): boolean =>
  (file.startsWith("scripts/") && file.endsWith(".test.ts")) ||
  file === "scripts/script-test-inputs.json";

/** Select the fast local repo guards relevant to `changedFiles`. */
export const selectPrGuards = (
  changedFiles: readonly string[],
  options: { readonly baseRef?: string } = {},
): readonly PrGuard[] => {
  const baseRef = options.baseRef ?? "origin/main";
  const guards: PrGuard[] = [];

  if (matchesAny(changedFiles, isOxlintFile)) {
    guards.push(
      {
        id: "oxlint-plugin-registry",
        label: "Oxlint plugin registry",
        command: ["bun", "scripts/check-oxlint-plugin-registry.ts"],
        fixHint:
          "Register new plugins/fixtures in oxlint.config.ts and .oxlint-plugins/README.md.",
      },
      {
        id: "oxlint-effective-config",
        label: "Oxlint effective config",
        command: ["bun", "scripts/check-oxlint-effective-config.ts"],
        fixHint:
          "Keep new non-design-lint rules in their own override block in oxlint.config.ts.",
      },
      {
        id: "guard-rollouts",
        label: "Guard rollout registrations",
        command: ["bun", "test", "scripts/guard-rollouts.test.ts"],
        fixHint:
          "Register dated rollouts in scripts/guard-rollouts/<id>.json and gate with guardEnforcesLine.",
      },
    );
  }

  if (matchesAny(changedFiles, isUiApiFile)) {
    guards.push({
      id: "ui-api-snapshot",
      label: "@stll/ui API snapshot",
      command: [
        "bun",
        "test",
        ".oxlint-plugins/__tests__/ui-api-snapshot.test.ts",
      ],
      fixHint:
        "Run `bun scripts/ui-api-snapshot.ts --write` (and update DESIGN.md if closed prop unions changed).",
    });
  }

  if (matchesAny(changedFiles, isPublishedPackageSource)) {
    guards.push({
      id: "package-api-report",
      label: "Published package API reports",
      command: ["bun", "run", "check:package-api", baseRef],
      fixHint:
        "Run `bun run update:package-api` and commit the updated api-report.json.",
    });
  }

  if (matchesAny(changedFiles, isParserGuardFile)) {
    guards.push({
      id: "parser-version-guard",
      label: "Parser version guard",
      command: ["bun", "scripts/check-parser-versions.ts"],
      env: { BASE_SHA: baseRef },
      fixHint:
        "Bump the parser version or add a `// parser-output-unchanged: <reason>` comment for pure refactors.",
    });
  }

  if (matchesAny(changedFiles, isScriptTestFile)) {
    guards.push({
      id: "test-input-coverage",
      label: "Script test input coverage",
      command: ["bun", "scripts/check-test-input-coverage.ts"],
      fixHint:
        "Register new scripts/*.test.ts files in scripts/script-test-inputs.json.",
    });
  }

  if (matchesAny(changedFiles, isDesignBaselineScope)) {
    guards.push({
      id: "design-lint-baseline",
      label: "Design-system lint backlog",
      command: ["bun", "scripts/design-lint-baseline.ts", "--check"],
      fixHint:
        "Run `bun scripts/design-lint-baseline.ts --write` if counts dropped, or fix new findings.",
    });
  }

  return guards;
};

const readChangedFiles = (baseRef: string): readonly string[] => {
  const mergeBase = execFileSync("git", ["merge-base", baseRef, "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    maxBuffer: CHILD_MAX_BUFFER,
  }).trim();
  const committed = execFileSync(
    "git",
    ["diff", "--name-only", `${mergeBase}...HEAD`],
    { cwd: REPO_ROOT, encoding: "utf-8", maxBuffer: CHILD_MAX_BUFFER },
  );
  const working = execFileSync("git", ["diff", "--name-only", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    maxBuffer: CHILD_MAX_BUFFER,
  });
  const untracked = execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard"],
    { cwd: REPO_ROOT, encoding: "utf-8", maxBuffer: CHILD_MAX_BUFFER },
  );
  return [
    ...new Set(
      `${committed}\n${working}\n${untracked}`
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    ),
  ].toSorted();
};

const parseArgs = (argv: readonly string[]) => {
  let baseRef = "origin/main";
  let listOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--list") {
      listOnly = true;
    } else if (arg === "--base" && argv[i + 1] !== undefined) {
      baseRef = argv[i + 1] ?? baseRef;
      i++;
    }
  }
  return { baseRef, listOnly };
};

if (import.meta.main) {
  const { baseRef, listOnly } = parseArgs(process.argv.slice(2));
  const changedFiles = readChangedFiles(baseRef);
  const guards = selectPrGuards(changedFiles, { baseRef });

  if (guards.length === 0) {
    console.log(
      `check-pr-guards: no scoped policy guards matched ${changedFiles.length} changed file(s).`,
    );
    process.exit(0);
  }

  if (listOnly) {
    for (const guard of guards) {
      console.log(`${guard.id}: ${guard.command.join(" ")}`);
    }
    process.exit(0);
  }

  let failed = 0;
  for (const guard of guards) {
    const start = performance.now();
    const [bin, ...args] = guard.command;
    if (bin === undefined) {
      continue;
    }
    const result = spawnSync(bin, args, {
      cwd: REPO_ROOT,
      env: guard.env ? { ...process.env, ...guard.env } : process.env,
      stdio: "inherit",
      maxBuffer: CHILD_MAX_BUFFER,
    });
    const elapsed = ((performance.now() - start) / 1000).toFixed(1);
    if (result.status !== 0) {
      failed++;
      console.error(
        `\n[FAIL] ${guard.label} (${elapsed}s)\n  fix: ${guard.fixHint}\n`,
      );
    } else {
      console.log(`[PASS] ${guard.label} (${elapsed}s)`);
    }
  }

  if (failed > 0) {
    console.error(
      `check-pr-guards: ${failed}/${guards.length} guard(s) failed.`,
    );
    process.exit(1);
  }
  console.log(`check-pr-guards: all ${guards.length} guard(s) passed.`);
}
