import {
  existsSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";

import {
  admitLocal,
  BOTH_GATES_REFUSED,
  type HostConfig,
  hostConfig,
  probeRemote,
  withCheckAdmissionAsync,
} from "./verify-admission";
import { VerifyError } from "./verify-error";
import {
  collectFastPreflightDiff,
  createFastPreflightRunner,
  formatFastPreflightPlan,
  planFastPreflightSteps,
  runFastPreflightSteps,
} from "./verify-fast";
import {
  readVerifyWorkflow,
  type VerifyWorkflowMode,
  type VerifyWorkflowStep,
} from "./verify-workflow";

export type VerifyOptions = {
  base: string;
  scope: "affected" | "all";
  mode: "check" | "fix-check" | "fix" | "list";
  fast?: true;
  emitPatch?: true;
  concurrency?: number;
};
const parsePositiveInteger = (
  value: string | undefined,
  label: string,
): number => {
  if (value === undefined || !/^[1-9]\d*$/u.test(value)) {
    throw new VerifyError(`${label} requires a positive integer`);
  }
  return Number.parseInt(value, 10);
};
export const defaultVerifyConcurrency = (): number => {
  const configured = process.env["STELLA_VERIFY_CONCURRENCY"];
  if (configured !== undefined && configured.trim() !== "") {
    return parsePositiveInteger(configured.trim(), "STELLA_VERIFY_CONCURRENCY");
  }
  return Math.min(4, Math.max(1, Math.floor(availableParallelism() / 2)));
};
export const parseVerifyArgs = (args: readonly string[]): VerifyOptions => {
  let fast: true | undefined;
  let emitPatch: true | undefined;
  let concurrency: number | undefined;
  let base = "origin/main";
  let scope: VerifyOptions["scope"] = "affected";
  let mode: VerifyOptions["mode"] = "check";
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case undefined:
        throw new VerifyError("Missing verify argument");
      case "--emit-fix-patch":
        emitPatch = true;
        break;
      case "--all":
        scope = "all";
        break;
      case "--fix":
        mode = "fix-check";
        break;
      case "--fix-only":
        mode = "fix";
        break;
      case "--fast":
        fast = true;
        break;
      case "--list":
        mode = "list";
        break;
      case "--base": {
        const value = args[++index];
        if (value === undefined || value.startsWith("-")) {
          throw new VerifyError("--base requires a ref");
        }
        base = value;
        break;
      }
      case "--concurrency": {
        concurrency = parsePositiveInteger(args[++index], "--concurrency");
        break;
      }
      default:
        throw new VerifyError(`Unknown verify argument: ${argument}`);
    }
  }
  if (fast && (mode === "fix" || mode === "fix-check")) {
    throw new VerifyError("--fast cannot be combined with --fix or --fix-only");
  }
  return {
    base,
    scope,
    mode,
    ...(fast === undefined ? {} : { fast }),
    ...(emitPatch === undefined ? {} : { emitPatch }),
    ...(concurrency === undefined ? {} : { concurrency }),
  };
};

export type VerifyStepRunner = (step: VerifyWorkflowStep) => number;
/** The executable set is exactly the workflow projection, including preparation. */
export const runVerifySteps = (
  steps: readonly VerifyWorkflowStep[],
  run: VerifyStepRunner,
): number => {
  const failures: string[] = [];
  for (const step of steps) {
    console.log(`verify: ${step.job} / ${step.name}`);
    const status = run(step);
    if (status === 0) {
      continue;
    }
    if (status === BOTH_GATES_REFUSED || step.phase === "prepare") {
      return status;
    }
    failures.push(step.name);
  }
  if (failures.length > 0) {
    console.error(`verify: failed: ${failures.join(", ")}`);
    return 1;
  }
  return 0;
};

export type AsyncVerifyStepRunner = (
  step: VerifyWorkflowStep,
  options: { buffered: boolean },
) => Promise<number>;

const formatSeconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
const isHeavyCheckStep = (step: VerifyWorkflowStep): boolean =>
  step.job.startsWith("code-quality-");
const CI_ONLY_ARM =
  /^([ \t]*)if \[\[ "\$\{STELLA_VERIFY_LOCAL:-false\}" == true \]\]; then\n([\s\S]*?)^\1else\n[\s\S]*?^\1fi$/gmu;
const effectiveLocalPrepareKey = (step: VerifyWorkflowStep): string => {
  const expanded = step.run.replaceAll(CI_ONLY_ARM, "$2");
  const localRun = expanded.includes("<<")
    ? expanded.trim()
    : expanded
        .split("\n")
        .map((line) => line.trim())
        .filter(
          (line) =>
            line.length > 0 &&
            !line.startsWith("#") &&
            line !== "unset CI_GENERATED_SOURCES_MANIFEST",
        )
        .join("\n");
  const sortedEnv = Object.keys(step.env)
    .toSorted()
    .map((key) => [key, step.env[key]]);
  return JSON.stringify({ cwd: step.cwd, env: sortedEnv, run: localRun });
};

export const runVerifyStepsConcurrent = async (
  steps: readonly VerifyWorkflowStep[],
  run: AsyncVerifyStepRunner,
  concurrency = defaultVerifyConcurrency(),
): Promise<number> => {
  const startedAt = performance.now();
  const prepareSteps = steps.filter(({ phase }) => phase === "prepare");
  const checkSteps = steps.filter(({ phase }) => phase === "check");
  const parallelChecks = checkSteps.filter((step) => !isHeavyCheckStep(step));
  const serialChecks = checkSteps.filter((step) => isHeavyCheckStep(step));
  const timings: { name: string; ms: number }[] = [];

  const seenPrepareKeys = new Set<string>();
  for (const step of prepareSteps) {
    const prepareKey = effectiveLocalPrepareKey(step);
    if (seenPrepareKeys.has(prepareKey)) {
      console.log(`verify: [skip duplicate] ${step.job} / ${step.name}`);
      continue;
    }
    console.log(`verify: ${step.job} / ${step.name}`);
    const stepStart = performance.now();
    const status = await run(step, { buffered: false });
    timings.push({ name: step.name, ms: performance.now() - stepStart });
    if (status !== 0) {
      return status;
    }
    seenPrepareKeys.add(prepareKey);
  }

  const limit = Math.max(1, concurrency);
  const buffered = limit > 1 && parallelChecks.length > 1;
  const parallelStatuses = Array.from<number | undefined>({
    length: parallelChecks.length,
  });
  let nextIndex = 0;
  let refused = false;

  const worker = async (): Promise<void> => {
    while (!refused) {
      const index = nextIndex;
      nextIndex += 1;
      const step = parallelChecks[index];
      if (step === undefined) {
        return;
      }
      if (!buffered) {
        console.log(`verify: ${step.job} / ${step.name}`);
      }
      const stepStart = performance.now();
      const status = await run(step, { buffered });
      const elapsed = performance.now() - stepStart;
      timings.push({ name: step.name, ms: elapsed });
      parallelStatuses[index] = status;
      if (status === BOTH_GATES_REFUSED) {
        refused = true;
        return;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limit, parallelChecks.length) }, worker),
  );
  if (parallelStatuses.includes(BOTH_GATES_REFUSED)) {
    return BOTH_GATES_REFUSED;
  }

  const failures: string[] = [];
  for (const [index, step] of parallelChecks.entries()) {
    const status = parallelStatuses[index];
    if (status !== undefined && status !== 0) {
      failures.push(step.name);
    }
  }

  for (const step of serialChecks) {
    console.log(`verify: ${step.job} / ${step.name}`);
    const stepStart = performance.now();
    const status = await run(step, { buffered: false });
    timings.push({ name: step.name, ms: performance.now() - stepStart });
    if (status === BOTH_GATES_REFUSED) {
      return BOTH_GATES_REFUSED;
    }
    if (status !== 0) {
      failures.push(step.name);
    }
  }

  const totalMs = performance.now() - startedAt;
  const slowest = timings
    .toSorted((left, right) => right.ms - left.ms)
    .slice(0, 3)
    .map(({ name, ms }) => `${name} (${formatSeconds(ms)})`)
    .join(", ");
  console.log(
    `verify: completed ${timings.length} steps in ${formatSeconds(totalMs)}${slowest === "" ? "" : ` (slowest: ${slowest})`}`,
  );

  if (failures.length > 0) {
    console.error(`verify: failed: ${failures.join(", ")}`);
    return 1;
  }
  return 0;
};

const repo = path.resolve(import.meta.dirname, "..");

/**
 * `RUNNER_TEMP` entries the local runner creates in place of the unmarked CI
 * steps that create them. The workflow test derives the required list from
 * the workflows; `localChecks` proves each entry exists before a marked step
 * can read it.
 */
export const LOCAL_RUNNER_TEMP_ENTRIES = {
  autofix: [
    "autofix-fix-paths",
    "autofix-format-paths",
    "autofix-lint-paths",
    "workflow-tooling",
  ],
  verify: [],
} as const satisfies Record<VerifyWorkflowMode, readonly string[]>;

const assertRunnerTempEntries = (
  temporary: string,
  mode: VerifyWorkflowMode,
): void => {
  for (const entry of LOCAL_RUNNER_TEMP_ENTRIES[mode]) {
    if (!existsSync(path.join(temporary, entry))) {
      throw new VerifyError(
        `The local runner did not create RUNNER_TEMP/${entry}`,
      );
    }
  }
};
const spawn = (
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): number =>
  Bun.spawnSync([...args], {
    cwd: repo,
    env,
    stdout: "inherit",
    stderr: "inherit",
  }).exitCode;
const git = (args: readonly string[]): string => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: repo,
    stdout: "pipe",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new VerifyError(`git ${args.join(" ")} failed`);
  }
  return result.stdout.toString();
};

export const runAutofixSteps = (
  steps: readonly VerifyWorkflowStep[],
  run: VerifyStepRunner,
): number => {
  for (const step of steps) {
    const status = run(step);
    if (status !== 0) {
      return status;
    }
  }
  return 0;
};

const createAsyncStepRunner =
  (env: NodeJS.ProcessEnv, run: VerifyStepRunner): AsyncVerifyStepRunner =>
  async (step, { buffered }) => {
    if (!buffered) {
      return run(step);
    }
    const stepStart = performance.now();
    const proc = Bun.spawn(["bash", "-euo", "pipefail", "-c", step.run], {
      cwd: path.resolve(repo, step.cwd),
      env: { ...env, ...step.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const elapsed = formatSeconds(performance.now() - stepStart);
    const badge = exitCode === 0 ? "ok" : `FAIL(${exitCode})`;
    console.log(`verify: [${badge} ${elapsed}] ${step.job} / ${step.name}`);
    if (stdout.length > 0) {
      process.stdout.write(stdout);
    }
    if (stderr.length > 0) {
      process.stderr.write(stderr);
    }
    return exitCode;
  };

const localChecks = async (
  options: VerifyOptions,
  config: HostConfig,
): Promise<number> => {
  const temporary = mkdtempSync(path.join(tmpdir(), "stella-verify-"));
  const mergeBase = git(["merge-base", options.base, "HEAD"]).trim();
  const installerArgs = path.join(temporary, "installer-argv");
  writeFileSync(
    installerArgs,
    config.installer === null ? "" : `${config.installer.join("\0")}\0`,
  );
  const env = {
    ...process.env,
    GENERATOR_IDS: "",
    BASE_REF: options.base.replace(/^origin\//u, ""),
    BASE_SHA: mergeBase,
    HEAD_SHA: git(["rev-parse", "HEAD"]).trim(),
    CHECK_BASE_REF: options.base,
    RATCHET_BASE_REF: mergeBase,
    MERGE_GROUP_BASE_SHA: "",
    EVENT_NAME: options.scope === "all" ? "workflow_dispatch" : "pull_request",
    AFFECTED_FLAG: options.scope === "all" ? "" : "--affected",
    TURBO_SCM_BASE: options.base,
    RUNNER_TEMP: temporary,
    GITHUB_WORKSPACE: repo,
    GITHUB_OUTPUT: path.join(temporary, "outputs"),
    GITHUB_ENV: path.join(temporary, "env"),
    GITHUB_STEP_SUMMARY: path.join(temporary, "summary"),
    REPOSITORY: "stella/stella",
    STELLA_VERIFY_LOCAL: "true",
    CI_GENERATED_SOURCES_MANIFEST: undefined,
    STELLA_WORKTREE_INSTALLER_ARGS_FILE: installerArgs,
  };
  const indexEnv = {
    ...process.env,
    GIT_INDEX_FILE: path.join(temporary, "fix-index"),
  };
  let initialTree: string | undefined;
  if (options.emitPatch) {
    if (
      spawn(["git", "read-tree", "HEAD"], indexEnv) !== 0 ||
      spawn(["git", "add", "--all", "--", "."], indexEnv) !== 0
    ) {
      return 2;
    }
    const tree = Bun.spawnSync(["git", "write-tree"], {
      cwd: repo,
      env: indexEnv,
      stdout: "pipe",
      stderr: "inherit",
    });
    if (tree.exitCode !== 0) {
      return tree.exitCode;
    }
    initialTree = tree.stdout.toString().trim();
  }
  const run: VerifyStepRunner = (step) =>
    Bun.spawnSync(["bash", "-euo", "pipefail", "-c", step.run], {
      cwd: path.resolve(repo, step.cwd),
      env: { ...env, ...step.env },
      stdout: "inherit",
      stderr: "inherit",
    }).exitCode;
  const runAsync = createAsyncStepRunner(env, run);
  try {
    const runChecks = async (): Promise<number> => {
      if (options.mode === "fix" || options.mode === "fix-check") {
        // Compare the live tree, so staged, unstaged and new files all participate.
        const untracked = git([
          "ls-files",
          "--others",
          "--exclude-standard",
          "-z",
        ])
          .split("\0")
          .filter(Boolean);
        const changed = [
          ...new Set([
            ...git([
              "diff",
              "--name-only",
              "-z",
              "--diff-filter=ACMR",
              mergeBase,
            ])
              .split("\0")
              .filter(Boolean),
            ...untracked,
          ]),
        ];
        const added = [
          ...new Set([
            ...git([
              "diff",
              "--name-only",
              "-z",
              "--no-renames",
              "--diff-filter=A",
              mergeBase,
            ])
              .split("\0")
              .filter(Boolean),
            ...untracked,
          ]),
        ];
        // A local run has no settled commit: the fixers see the whole branch.
        for (const name of ["autofix-changed-paths", "autofix-fix-paths"]) {
          writeFileSync(path.join(temporary, name), `${changed.join("\0")}\0`);
        }
        writeFileSync(
          path.join(temporary, "autofix-added-paths"),
          `${added.join("\0")}\0`,
        );
        const selected = Bun.spawnSync(
          [
            process.execPath,
            "scripts/autofix-select-paths.ts",
            path.join(temporary, "autofix-fix-paths"),
            path.join(temporary, "autofix-format-paths"),
            path.join(temporary, "autofix-lint-paths"),
          ],
          { cwd: repo, stdout: "inherit", stderr: "inherit" },
        );
        if (selected.exitCode !== 0) {
          return selected.exitCode;
        }
        // CI checks the lockfile tooling out at the workflow's own revision.
        // The local run already executes this checkout's scripts, so the
        // checkout is the tooling.
        symlinkSync(repo, path.join(temporary, "workflow-tooling"));
        assertRunnerTempEntries(temporary, "autofix");
        const plan = Bun.spawnSync(
          [process.execPath, "scripts/autofix-plan.ts", "plan"],
          {
            cwd: repo,
            stdin: new TextEncoder().encode(
              [
                ...new Set([
                  ...git(["diff", "--name-only", "-z", mergeBase])
                    .split("\0")
                    .filter(Boolean),
                  ...untracked,
                ]),
              ].join("\n"),
            ),
            stdout: "pipe",
            stderr: "inherit",
          },
        );
        if (plan.exitCode !== 0) {
          return plan.exitCode;
        }
        const ids = /^ids=(.*)$/mu.exec(plan.stdout.toString())?.at(1);
        env.GENERATOR_IDS = ids ?? "";
        const fixed = runAutofixSteps(
          readVerifyWorkflow({ root: repo, mode: "autofix" }),
          run,
        );
        if (fixed !== 0 || options.mode === "fix") {
          return fixed;
        }
      }
      assertRunnerTempEntries(temporary, "verify");
      return await runVerifyStepsConcurrent(
        readVerifyWorkflow({ root: repo, mode: "verify" }),
        runAsync,
        options.concurrency,
      );
    };
    const status = await runChecks();
    if (initialTree !== undefined) {
      if (spawn(["git", "add", "--all", "--", "."], indexEnv) !== 0) {
        throw new VerifyError("Unable to collect remote autofix files");
      }
      const patch = Bun.spawnSync(
        ["git", "diff", "--binary", "--no-ext-diff", "--cached", initialTree],
        { cwd: repo, env: indexEnv, stdout: "pipe", stderr: "inherit" },
      );
      if (patch.exitCode !== 0) {
        throw new VerifyError("Unable to collect remote autofix changes");
      }
      console.log(`STELLA_VERIFY_PATCH=${patch.stdout.toBase64()}`);
    }
    return status;
  } finally {
    const baseTree = path.join(temporary, "typecheck-base");
    if (existsSync(path.join(baseTree, ".git"))) {
      spawn(["git", "worktree", "remove", "--force", baseTree]);
    }
    rmSync(temporary, { recursive: true, force: true });
  }
};

export const splitRemoteFixOutput = (
  output: string,
): { log: string; patch: Buffer | undefined } => {
  const marker = /^STELLA_VERIFY_PATCH=([A-Za-z0-9+/=]*)$/mu;
  const payload = marker.exec(output)?.at(1);
  return {
    log: output.replace(marker, ""),
    patch: payload === undefined ? undefined : Buffer.from(payload, "base64"),
  };
};

type RemoteCheckOptions = {
  args: readonly string[];
  options: VerifyOptions;
  config: HostConfig;
};
const remoteChecks = ({
  args,
  options,
  config,
}: RemoteCheckOptions): number => {
  if (config.remote === null) {
    return BOTH_GATES_REFUSED;
  }
  const fixes = options.mode === "fix" || options.mode === "fix-check";
  // Transport carries HEAD ancestry, not this checkout's named remote refs.
  const base = git(["merge-base", options.base, "HEAD"]).trim();
  const remoteArgs = [...args];
  let hasBase = false;
  for (let index = 0; index < remoteArgs.length; index += 1) {
    if (remoteArgs[index] !== "--base") {
      continue;
    }
    remoteArgs[index + 1] = base;
    hasBase = true;
    index += 1;
  }
  if (!hasBase) {
    remoteArgs.push("--base", base);
  }
  if (!fixes) {
    return spawn([
      ...config.remote,
      repo,
      "--",
      "bash",
      "scripts/verify.sh",
      ...remoteArgs,
    ]);
  }
  const result = Bun.spawnSync(
    [
      ...config.remote,
      repo,
      "--",
      "bash",
      "scripts/verify.sh",
      ...remoteArgs,
      "--emit-fix-patch",
    ],
    { cwd: repo, stdout: "pipe", stderr: "inherit" },
  );
  const { log, patch } = splitRemoteFixOutput(result.stdout.toString());
  process.stdout.write(log);
  if (result.exitCode === BOTH_GATES_REFUSED) {
    return result.exitCode;
  }
  if (patch === undefined) {
    if (result.exitCode !== 0) {
      return result.exitCode;
    }
    console.error("verify: remote fix produced no change receipt");
    return 2;
  }
  if (patch.length > 0) {
    const apply = (check: boolean) =>
      Bun.spawnSync(
        ["git", "apply", ...(check ? ["--check"] : []), "--binary", "-"],
        {
          cwd: repo,
          stdin: patch,
          stdout: "inherit",
          stderr: "inherit",
        },
      ).exitCode;
    if (apply(true) !== 0 || apply(false) !== 0) {
      console.error(
        "verify: remote fixes conflict with the local tree; changes were not applied",
      );
      return 2;
    }
  }
  return result.exitCode;
};

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const options = parseVerifyArgs(args);
    if (options.fast) {
      const diff = collectFastPreflightDiff(repo, options.base);
      const steps = planFastPreflightSteps(
        diff.changedFiles,
        diff.base,
        diff.context,
      );
      if (options.mode === "list") {
        for (const line of formatFastPreflightPlan(steps)) {
          console.log(line);
        }
      } else {
        process.exitCode = await runFastPreflightSteps(
          steps,
          createFastPreflightRunner(repo),
          options.concurrency ?? defaultVerifyConcurrency(),
        );
      }
    } else if (options.mode === "list") {
      for (const step of readVerifyWorkflow({ root: repo, mode: "verify" })) {
        console.log(`${step.phase}: ${step.job} / ${step.name}`);
      }
    } else {
      const config = hostConfig();
      const admissionSteps = [
        ...(options.mode === "fix" || options.mode === "fix-check"
          ? readVerifyWorkflow({ root: repo, mode: "autofix" })
          : []),
        ...(options.mode !== "fix"
          ? readVerifyWorkflow({ root: repo, mode: "verify" })
          : []),
      ];
      const status = await withCheckAdmissionAsync({
        alreadyRemote: process.env["REMOTE_CHECK"] === "1",
        admitLocal: () =>
          admitLocal({
            config,
            repo,
            command: [
              "bash",
              "-c",
              admissionSteps.map(({ run }) => run).join("\n"),
            ],
          }),
        probeRemote: () => probeRemote(config, repo),
        runLocal: async () => localChecks(options, config),
        runRemote: () => remoteChecks({ args, options, config }),
        report: (message) => console.error(message),
      });
      process.exitCode = status;
    }
  } catch (error) {
    console.error(
      `verify: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 2;
  }
}
