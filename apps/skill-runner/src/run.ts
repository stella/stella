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

/**
 * Run one skill command: lay out the skill and the chat's workspace in a
 * fresh folder, run the command with an allowlisted environment, store the
 * workspace back and report what changed. The skill's files sit outside the
 * workspace, so nothing a command does to them is kept.
 */
export const runSkillCommand = async (
  input: SkillRunnerInput,
  transport: ArchiveTransport,
  options: {
    environment?: Readonly<Record<string, string | undefined>>;
    root?: string;
  } = {},
): Promise<SkillRunnerResult> => {
  const root = await mkdtemp(path.join(options.root ?? tmpdir(), "skill-run-"));
  try {
    const workspace = path.join(root, "workspace");
    const skillDir = path.join(root, "skills", input.skill.name);
    const places = {
      home: path.join(root, "home"),
      cache: path.join(root, "cache"),
      tmp: path.join(root, "tmp"),
      skillDir,
    };
    await Promise.all(
      [workspace, places.home, places.cache, places.tmp].map(
        async (dir) => await mkdir(dir, { recursive: true }),
      ),
    );

    const skillArchive = await transport.get(
      input.skill.getUrl,
      SKILL_LIMITS.archiveBytes,
    );
    const digest = sha256Hex(skillArchive);
    if (digest !== input.skill.sha256) {
      throw new SkillRunnerArchiveError({
        message: "Skill archive does not match its digest",
      });
    }
    await extractArchive(skillArchive, skillDir, SKILL_LIMITS);
    if (input.workspaceGetUrl !== null) {
      await extractArchive(
        await transport.get(
          input.workspaceGetUrl,
          WORKSPACE_LIMITS.archiveBytes,
        ),
        workspace,
        WORKSPACE_LIMITS,
      );
    }

    const before = await listFolder(workspace, WORKSPACE_LIMITS);
    const ran = await runCommand({
      argv: input.command.argv,
      cwd: path.join(workspace, input.command.cwd),
      env: commandEnvironment(
        options.environment ?? lambdaEnvironment(),
        places,
        input.egressProxyUrl,
      ),
      timeoutMs: input.command.timeoutMs,
    });
    const after = await listFolder(workspace, WORKSPACE_LIMITS);
    await transport.put(
      input.workspacePutUrl,
      await packFolder(workspace, after),
    );
    return { ...ran, ...changes(before, after) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};
