import path from "node:path";

import { VerifyError } from "./verify-error";

export type FastPreflightStep = {
  id: string;
  name: string;
  command: readonly string[];
  env?: Record<string, string>;
};

export type FastPreflightContext = {
  deletedFiles?: ReadonlySet<string>;
  deletedOrRenamedFiles?: ReadonlySet<string>;
  apiTestTopologyChanged?: boolean;
};

export type FastPreflightDiff = {
  base: string;
  changedFiles: string[];
  context: FastPreflightContext;
};

export type FastPreflightStepResult = {
  step: FastPreflightStep;
  exitCode: number;
  elapsedMs: number;
  stdout: string;
  stderr: string;
};

export type FastPreflightRunner = (
  step: FastPreflightStep,
) => Promise<FastPreflightStepResult>;

const TS_FILE_RE = /\.tsx?$/u;
const API_TEST_FILE_RE = /^apps\/api\/src\/.*\.test\.ts$/u;
const CASE_LAW_PACKAGE_RE = /^packages\/case-law-[^/]+\//u;
const PACKAGE_MANIFEST_RE = /^packages\/[^/]+\/package\.json$/u;
const TOP_LEVEL_API_LIB_RE = /^apps\/api\/src\/lib\/[^/]+$/u;

const normalizePath = (filePath: string): string =>
  filePath.replaceAll("\\", "/").replace(/^\.\//u, "");

const isSrcPath = (filePath: string): boolean =>
  filePath.startsWith("src/") || filePath.includes("/src/");

export const planFastPreflightSteps = (
  changedFiles: readonly string[],
  base: string,
  context?: FastPreflightContext,
): FastPreflightStep[] => {
  const normalized = [
    ...new Set(changedFiles.map(normalizePath).filter(Boolean)),
  ].toSorted();
  if (normalized.length === 0) {
    return [];
  }

  const deletedFiles = context?.deletedFiles;
  const deletedOrRenamedFiles = context?.deletedOrRenamedFiles;

  const steps: FastPreflightStep[] = [];

  const tsFiles = normalized.filter(
    (file) => TS_FILE_RE.test(file) && !(deletedFiles?.has(file) ?? false),
  );
  if (tsFiles.length > 0) {
    steps.push({
      id: "oxlint-type-aware",
      name: `oxlint --type-aware --type-check (${tsFiles.length} ${tsFiles.length === 1 ? "file" : "files"})`,
      command: [
        "bun",
        "--bun",
        "oxlint",
        "-c",
        "oxlint.config.ts",
        "--no-error-on-unmatched-pattern",
        "--type-aware",
        "--type-check",
        ...tsFiles,
      ],
    });
  }

  const hasManifestOrLockChange = normalized.some(
    (file) =>
      file === "bun.lock" ||
      file === "package.json" ||
      file.endsWith("/package.json"),
  );
  if (hasManifestOrLockChange) {
    steps.push(
      {
        id: "dedupe-check",
        name: "bun dedupe --check",
        command: ["bun", "--no-env-file", "dedupe", "--check"],
      },
      {
        id: "lint-ws",
        name: "bun run lint:ws",
        command: ["bun", "run", "lint:ws"],
      },
    );
  }

  const hasPeakRssChange = normalized.some(
    (file) =>
      file === "test-peak-rss.json" || file.endsWith("/test-peak-rss.json"),
  );
  const hasApiTestChange =
    context?.apiTestTopologyChanged ??
    normalized.some((file) => API_TEST_FILE_RE.test(file));
  if (hasPeakRssChange || hasApiTestChange) {
    steps.push({
      id: "api-memory-batches",
      name: "api test memory batches",
      command: ["bun", "test", "apps/api/scripts/test-memory-batches.test.ts"],
    });
  }

  const hasCaseLawChange = normalized.some(
    (file) =>
      file.startsWith("apps/api/src/handlers/case-law/") ||
      file.startsWith("apps/api/src/lib/case-law/") ||
      CASE_LAW_PACKAGE_RE.test(file),
  );
  if (hasCaseLawChange) {
    steps.push({
      id: "parser-versions",
      name: "check parser versions",
      command: ["bun", "scripts/check-parser-versions.ts"],
      env: { BASE_SHA: base, HEAD_SHA: "HEAD" },
    });
  }

  const hasGeneratedGuardChange = normalized.some(
    (file) =>
      file === "scripts/generated-files.ts" ||
      file.startsWith("apps/api/src/lib/") ||
      file.startsWith("packages/"),
  );
  if (hasGeneratedGuardChange) {
    steps.push({
      id: "generated-files-guard",
      name: "generated files guard (--guard-a)",
      command: ["bun", "scripts/generated-files-guard.ts", "--guard-a"],
    });
  }

  const hasCiChecksChange = normalized.some(
    (file) =>
      file.startsWith(".github/ci-checks/") ||
      file === ".github/global-rule-inputs.json",
  );
  if (hasCiChecksChange) {
    steps.push({
      id: "ci-checks-guards",
      name: "ci-checks partition & pool tests",
      command: [
        "bun",
        "test",
        "scripts/global-rule-inputs.test.ts",
        "scripts/ci-checks-partition.test.ts",
        "scripts/ci-check-pool.test.ts",
      ],
    });
  }

  if (normalized.includes("scripts/design-lint-baseline.json")) {
    steps.push({
      id: "design-lint-baseline",
      name: "design lint baseline check",
      command: ["bun", "scripts/design-lint-baseline.ts", "--check"],
    });
  }

  const hasAgentInstructionChange = normalized.some(
    (file) =>
      file.startsWith(".agents/") ||
      file.startsWith(".ai/") ||
      file.startsWith(".claude/"),
  );
  const hasMovedOrDeletedSrcFile =
    deletedOrRenamedFiles !== undefined &&
    [...deletedOrRenamedFiles].some((file) => isSrcPath(normalizePath(file)));
  if (hasAgentInstructionChange || hasMovedOrDeletedSrcFile) {
    steps.push({
      id: "instruction-references",
      name: "instruction references check",
      command: ["bun", "scripts/check-instruction-references.ts", "--check"],
    });
  }

  const hasOwnershipChange = normalized.some(
    (file) =>
      file.startsWith("scripts/ownership/") ||
      file.startsWith("docs/module-ownership/"),
  );
  if (hasOwnershipChange) {
    steps.push({
      id: "module-ownership",
      name: "module ownership check",
      command: ["bun", "scripts/ownership.ts", "--check"],
    });
  }

  const hasRatchetChange = normalized.some(
    (file) =>
      PACKAGE_MANIFEST_RE.test(file) ||
      file.startsWith("scripts/ratchet") ||
      TOP_LEVEL_API_LIB_RE.test(file),
  );
  if (hasRatchetChange) {
    steps.push({
      id: "ratchet-check",
      name: "ratchet check",
      command: ["bun", "scripts/ratchet.ts", "--check"],
      env: { RATCHET_BASE_REF: base },
    });
  }

  return steps;
};

const runGit = (repo: string, args: readonly string[]): string => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim();
    throw new VerifyError(
      `git ${args.join(" ")} failed${detail === "" ? "" : `: ${detail}`}`,
    );
  }
  return result.stdout.toString();
};

export const parseNameStatusZ = (
  output: string,
): {
  changedFiles: string[];
  deletedFiles: Set<string>;
  deletedOrRenamedFiles: Set<string>;
  apiTestTopologyChanged: boolean;
} => {
  const tokens = output.split("\0");
  const changedFiles: string[] = [];
  const deletedFiles = new Set<string>();
  const deletedOrRenamedFiles = new Set<string>();
  let apiTestTopologyChanged = false;

  let index = 0;
  while (index < tokens.length) {
    const status = tokens[index];
    index += 1;
    if (status === undefined || status === "") {
      continue;
    }
    const kind = status[0];
    if (kind === "R" || kind === "C") {
      const oldPath = tokens[index];
      const newPath = tokens[index + 1];
      index += 2;
      if (oldPath !== undefined && oldPath !== "") {
        const normalizedOld = normalizePath(oldPath);
        changedFiles.push(normalizedOld);
        if (kind === "R") {
          deletedFiles.add(normalizedOld);
          deletedOrRenamedFiles.add(normalizedOld);
          if (API_TEST_FILE_RE.test(normalizedOld)) {
            apiTestTopologyChanged = true;
          }
        }
      }
      if (newPath !== undefined && newPath !== "") {
        const normalizedNew = normalizePath(newPath);
        changedFiles.push(normalizedNew);
        if (kind === "R") {
          deletedOrRenamedFiles.add(normalizedNew);
          if (API_TEST_FILE_RE.test(normalizedNew)) {
            apiTestTopologyChanged = true;
          }
        }
      }
      continue;
    }
    const filePath = tokens[index];
    index += 1;
    if (filePath === undefined || filePath === "") {
      continue;
    }
    const normalizedPath = normalizePath(filePath);
    changedFiles.push(normalizedPath);
    if (kind === "D") {
      deletedFiles.add(normalizedPath);
      deletedOrRenamedFiles.add(normalizedPath);
      if (API_TEST_FILE_RE.test(normalizedPath)) {
        apiTestTopologyChanged = true;
      }
    } else if (kind === "A" && API_TEST_FILE_RE.test(normalizedPath)) {
      apiTestTopologyChanged = true;
    }
  }

  return {
    changedFiles,
    deletedFiles,
    deletedOrRenamedFiles,
    apiTestTopologyChanged,
  };
};

export const collectFastPreflightDiff = (
  repo: string,
  baseRef: string,
): FastPreflightDiff => {
  let base = baseRef;
  const mergeBaseResult = Bun.spawnSync(
    ["git", "merge-base", baseRef, "HEAD"],
    {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (mergeBaseResult.exitCode === 0) {
    const resolved = mergeBaseResult.stdout.toString().trim();
    if (resolved !== "") {
      base = resolved;
    }
  }

  const nameStatus = parseNameStatusZ(
    runGit(repo, ["diff", "--name-status", "-z", base]),
  );
  const untracked = runGit(repo, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ])
    .split("\0")
    .map(normalizePath)
    .filter(Boolean);

  const untrackedHasApiTest = untracked.some((file) =>
    API_TEST_FILE_RE.test(file),
  );
  const changedFiles = [
    ...new Set([...nameStatus.changedFiles, ...untracked]),
  ].toSorted();

  return {
    base,
    changedFiles,
    context: {
      deletedFiles: nameStatus.deletedFiles,
      deletedOrRenamedFiles: nameStatus.deletedOrRenamedFiles,
      apiTestTopologyChanged:
        nameStatus.apiTestTopologyChanged || untrackedHasApiTest,
    },
  };
};

const formatSeconds = (ms: number): string => `${(ms / 1000).toFixed(2)}s`;

export const formatFastPreflightPlan = (
  steps: readonly FastPreflightStep[],
): string[] => {
  if (steps.length === 0) {
    return ["verify --fast: no checks needed for current diff"];
  }
  return steps.map((step) => `fast: ${step.name} — ${step.command.join(" ")}`);
};

export const createFastPreflightRunner =
  (
    repo: string,
    baseEnv: NodeJS.ProcessEnv = process.env,
  ): FastPreflightRunner =>
  async (step) => {
    const startedAt = performance.now();
    const proc = Bun.spawn([...step.command], {
      cwd: path.resolve(repo),
      env: { ...baseEnv, ...step.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return {
      step,
      exitCode,
      elapsedMs: performance.now() - startedAt,
      stdout,
      stderr,
    };
  };

type FastPreflightIO = {
  log: (line: string) => void;
  error: (line: string) => void;
  writeStdout: (chunk: string) => void;
  writeStderr: (chunk: string) => void;
};

const DEFAULT_FAST_PREFLIGHT_IO: FastPreflightIO = {
  log: (line) => {
    console.log(line);
  },
  error: (line) => {
    console.error(line);
  },
  writeStdout: (chunk) => {
    process.stdout.write(chunk);
  },
  writeStderr: (chunk) => {
    process.stderr.write(chunk);
  },
};

export const runFastPreflightSteps = async (
  steps: readonly FastPreflightStep[],
  run: FastPreflightRunner,
  concurrency: number,
  io: FastPreflightIO = DEFAULT_FAST_PREFLIGHT_IO,
): Promise<number> => {
  if (steps.length === 0) {
    io.log("verify --fast: no checks needed for current diff (0.00s)");
    return 0;
  }

  const startedAt = performance.now();
  const limit = Math.max(1, concurrency);
  const results = Array.from<FastPreflightStepResult | undefined>({
    length: steps.length,
  });
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      const step = steps[index];
      if (step === undefined) {
        return;
      }
      const result = await run(step);
      results[index] = result;
      const badge = result.exitCode === 0 ? "ok" : `FAIL(${result.exitCode})`;
      io.log(
        `verify --fast: [${badge} ${formatSeconds(result.elapsedMs)}] ${step.name}`,
      );
      if (result.exitCode !== 0) {
        if (result.stdout.length > 0) {
          io.writeStdout(result.stdout);
        }
        if (result.stderr.length > 0) {
          io.writeStderr(result.stderr);
        }
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limit, steps.length) }, worker),
  );

  const completed = results.filter(
    (entry): entry is FastPreflightStepResult => entry !== undefined,
  );
  const totalMs = performance.now() - startedAt;
  const failures = completed.filter((entry) => entry.exitCode !== 0);
  const slowest = completed
    .toSorted((left, right) => right.elapsedMs - left.elapsedMs)
    .slice(0, 3)
    .map(({ step, elapsedMs }) => `${step.name} (${formatSeconds(elapsedMs)})`)
    .join(", ");

  io.log(
    `verify --fast: completed ${completed.length} ${completed.length === 1 ? "step" : "steps"} in ${formatSeconds(totalMs)}${slowest === "" ? "" : ` (slowest: ${slowest})`}`,
  );

  if (failures.length > 0) {
    io.error(
      `verify --fast: ${failures.length} ${failures.length === 1 ? "check" : "checks"} failed:`,
    );
    for (const failure of failures) {
      io.error(
        `  - ${failure.step.name} (exit ${failure.exitCode}): ${failure.step.command.join(" ")}`,
      );
    }
    return 1;
  }

  return 0;
};
