import { Result } from "better-result";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  SKILL_RUNNER_LIMITS,
  type SkillRunnerInput,
  type SkillRunnerResult,
} from "@stll/api-contract/skill-runner";
import { sha256Hex } from "@stll/sha256/node";

import {
  extractArchive,
  type FolderFile,
  listFolder,
  packFolder,
  SkillRunnerArchiveError,
} from "./archive";
import { runCommand } from "./command";
import { commandEnvironment, lambdaEnvironment } from "./env";
import {
  liveProcessIds,
  type SkillRunnerIsolationError,
  sweepNewProcesses,
} from "./isolation";

/** How the runner moves archives; the handler uses HTTPS to presigned URLs. */
export type ArchiveTransport = {
  get: (url: string, maxBytes: number) => Promise<Uint8Array>;
  put: (url: string, bytes: Uint8Array) => Promise<void>;
};

const WORKSPACE_LIMITS = {
  archiveBytes: SKILL_RUNNER_LIMITS.workspaceArchiveBytes,
  uncompressedBytes: SKILL_RUNNER_LIMITS.workspaceUncompressedBytes,
  files: SKILL_RUNNER_LIMITS.workspaceFiles,
} as const;

const SKILL_LIMITS = {
  archiveBytes: SKILL_RUNNER_LIMITS.skillArchiveBytes,
  uncompressedBytes: SKILL_RUNNER_LIMITS.skillUncompressedBytes,
  files: SKILL_RUNNER_LIMITS.skillFiles,
} as const;

const changes = (
  before: ReadonlyMap<string, FolderFile>,
  after: ReadonlyMap<string, FolderFile>,
) => ({
  changedFiles: [...after]
    .filter(([file, { sha256 }]) => before.get(file)?.sha256 !== sha256)
    .map(([file, { sizeBytes, sha256 }]) => ({
      path: file,
      sizeBytes,
      sha256,
    })),
  removedFiles: [...before.keys()].filter((file) => !after.has(file)),
});

const transfer = async <T>(
  message: string,
  move: () => Promise<T>,
): Promise<Result<T, SkillRunnerArchiveError>> =>
  await Result.tryPromise({
    try: move,
    catch: (cause) => new SkillRunnerArchiveError({ message, cause }),
  });

type RunError = SkillRunnerArchiveError | SkillRunnerIsolationError;

/**
 * The process table to sweep after the command. Only in the runner's own
 * execution environment, where every process that appears during a command
 * is the command's.
 */
export type ProcessSweep = {
  procRoot: string;
  kill: (pid: number) => void;
};

type RunOptions = {
  environment?: Readonly<Record<string, string | undefined>>;
  root?: string;
  sweep?: ProcessSweep;
};

const runInFolder = async (
  root: string,
  input: SkillRunnerInput,
  transport: ArchiveTransport,
  {
    environment,
    sweep,
  }: {
    environment: Readonly<Record<string, string | undefined>>;
    sweep: ProcessSweep | undefined;
  },
): Promise<Result<SkillRunnerResult, RunError>> => {
  const workspace = path.join(root, "workspace");
  const skillDir = path.join(root, "skills", input.skill.name);
  const places = {
    home: path.join(root, "home"),
    cache: path.join(root, "cache"),
    tmp: path.join(root, "tmp"),
    skillDir,
  };
  const prepared = await transfer("Run folders could not be made", async () => {
    for (const dir of [workspace, places.home, places.cache, places.tmp]) {
      await mkdir(dir, { recursive: true });
    }
  });
  if (prepared.isErr()) {
    return Result.err(prepared.error);
  }

  const skillArchive = await transfer(
    "Skill archive could not be downloaded",
    async () =>
      await transport.get(input.skill.getUrl, SKILL_LIMITS.archiveBytes),
  );
  if (skillArchive.isErr()) {
    return Result.err(skillArchive.error);
  }
  if (sha256Hex(skillArchive.value) !== input.skill.sha256) {
    return Result.err(
      new SkillRunnerArchiveError({
        message: "Skill archive does not match its digest",
      }),
    );
  }
  const skill = await extractArchive(
    skillArchive.value,
    skillDir,
    SKILL_LIMITS,
  );
  if (skill.isErr()) {
    return Result.err(skill.error);
  }
  const workspaceUrl = input.workspaceGetUrl;
  if (workspaceUrl !== null) {
    const archive = await transfer(
      "Workspace could not be downloaded",
      async () =>
        await transport.get(workspaceUrl, WORKSPACE_LIMITS.archiveBytes),
    );
    if (archive.isErr()) {
      return Result.err(archive.error);
    }
    const laid = await extractArchive(
      archive.value,
      workspace,
      WORKSPACE_LIMITS,
    );
    if (laid.isErr()) {
      return Result.err(laid.error);
    }
  }

  const before = await listFolder(workspace, WORKSPACE_LIMITS);
  if (before.isErr()) {
    return Result.err(before.error);
  }
  let baseline: ReadonlySet<number> | undefined;
  if (sweep !== undefined) {
    const live = await liveProcessIds(sweep.procRoot);
    if (live.isErr()) {
      return Result.err(live.error);
    }
    baseline = live.value;
  }
  const ran = await runCommand({
    argv: input.command.argv,
    cwd: path.join(workspace, input.command.cwd),
    env: commandEnvironment(environment, places, input.egressProxyUrl),
    timeoutMs: input.command.timeoutMs,
  });
  if (sweep !== undefined && baseline !== undefined) {
    const swept = await sweepNewProcesses({
      procRoot: sweep.procRoot,
      baseline,
      kill: sweep.kill,
    });
    if (swept.isErr()) {
      return Result.err(swept.error);
    }
  }
  const after = await listFolder(workspace, WORKSPACE_LIMITS);
  if (after.isErr()) {
    return Result.err(after.error);
  }
  const packed = await packFolder(workspace, after.value);
  if (packed.isErr()) {
    return Result.err(packed.error);
  }
  // The next run downloads this archive under the same cap; a workspace it
  // would refuse is never stored.
  if (packed.value.byteLength > WORKSPACE_LIMITS.archiveBytes) {
    return Result.err(
      new SkillRunnerArchiveError({
        message: "The workspace is larger than a run may store",
      }),
    );
  }
  const stored = await transfer(
    "Workspace could not be stored",
    async () => await transport.put(input.workspacePutUrl, packed.value),
  );
  if (stored.isErr()) {
    return Result.err(stored.error);
  }
  return Result.ok({ ...ran, ...changes(before.value, after.value) });
};

/**
 * Run one skill command: lay out the skill and the chat's workspace in a
 * fresh folder, run the command with an allowlisted environment, store the
 * workspace back and report what changed. The skill's files sit outside the
 * workspace, so nothing a command does to them is kept. The folder is
 * removed whatever the outcome.
 */
export const runSkillCommand = async (
  input: SkillRunnerInput,
  transport: ArchiveTransport,
  options: RunOptions = {},
): Promise<Result<SkillRunnerResult, RunError>> => {
  const root = await transfer(
    "Run folder could not be made",
    async () =>
      await mkdtemp(path.join(options.root ?? tmpdir(), "skill-run-")),
  );
  if (root.isErr()) {
    return Result.err(root.error);
  }
  const outcome = await runInFolder(root.value, input, transport, {
    environment: options.environment ?? lambdaEnvironment(),
    sweep: options.sweep,
  });
  await rm(root.value, { recursive: true, force: true });
  return outcome;
};
