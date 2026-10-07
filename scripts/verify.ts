import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  admitLocal,
  BOTH_GATES_REFUSED,
  hostConfig,
  probeRemote,
  withCheckAdmission,
  type HostConfig,
} from "./verify-admission";
import { VerifyError } from "./verify-error";
import { readVerifyWorkflow, type VerifyWorkflowStep } from "./verify-workflow";

export type VerifyOptions = {
  base: string;
  scope: "affected" | "all";
  mode: "check" | "fix-check" | "fix" | "list";
  emitPatch?: true;
};
export const parseVerifyArgs = (args: readonly string[]): VerifyOptions => {
  let emitPatch: true | undefined;
  let base = "origin/main";
  let scope: VerifyOptions["scope"] = "affected";
  let mode: VerifyOptions["mode"] = "check";
  for (let index = 0; index < args.length; index += 1) {
    switch (args[index]) {
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
      default:
        throw new VerifyError(`Unknown verify argument: ${args[index]}`);
    }
  }
  return {
    base,
    scope,
    mode,
    ...(emitPatch === undefined ? {} : { emitPatch }),
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
    if (step.phase === "prepare") {
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

const repo = path.resolve(import.meta.dirname, "..");
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

const localChecks = (options: VerifyOptions, config: HostConfig): number => {
  const temporary = mkdtempSync(path.join(tmpdir(), "stella-verify-"));
  const mergeBase = git(["merge-base", options.base, "HEAD"]).trim();
  const installerArgs = path.join(temporary, "installer-argv");
  writeFileSync(installerArgs, `${config.installer.join("\0")}\0`);
  const env = {
    ...process.env,
    GENERATOR_IDS: "",
    BASE_REF: options.base.replace(/^origin\//u, ""),
    BASE_SHA: mergeBase,
    CHECK_BASE_REF: options.base,
    RATCHET_BASE_REF: mergeBase,
    MERGE_GROUP_BASE_SHA: "",
    EVENT_NAME: options.scope === "all" ? "workflow_dispatch" : "pull_request",
    AFFECTED_FLAG: options.scope === "all" ? "" : "--affected",
    TURBO_SCM_BASE: options.base,
    RUNNER_TEMP: temporary,
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
  try {
    const runChecks = (): number => {
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
        writeFileSync(
          path.join(temporary, "autofix-changed-paths"),
          `${changed.join("\0")}\0`,
        );
        writeFileSync(
          path.join(temporary, "autofix-added-paths"),
          `${added.join("\0")}\0`,
        );
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
      return runVerifySteps(
        readVerifyWorkflow({ root: repo, mode: "verify" }),
        run,
      );
    };
    const status = runChecks();
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
      console.log(`STELLA_VERIFY_PATCH=${patch.stdout.toString("base64")}`);
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
        { cwd: repo, stdin: patch, stdout: "inherit", stderr: "inherit" },
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
    if (options.mode === "list") {
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
      const status = withCheckAdmission({
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
        runLocal: () => localChecks(options, config),
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
