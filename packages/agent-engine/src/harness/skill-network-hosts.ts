import { Result } from "better-result";
import { open } from "node:fs/promises";
import path from "node:path";

import { parseSkillFile } from "@stll/skills/frontmatter";
import { readSkillNetworkHosts } from "@stll/skills/network-hosts";

import type { HarnessSkillFolder } from "./adapter";

/** As much of a `SKILL.md` as the desktop lists a folder for. */
const SKILL_FILE_MAX_BYTES = 1024 * 1024;

export type SkillFolderNetworkHosts = {
  /** Every host the turn's skills declare, once each. */
  hosts: readonly string[];
  /** Skills whose declaration could not be read; they add no host. */
  unreadable: readonly string[];
};

/** Why a skill folder's `SKILL.md` was not read. */
type SkillFileUnreadable = { reason: "too_large" | "unreadable" };

const readSkillFile = async (
  folder: string,
): Promise<Result<string, SkillFileUnreadable>> => {
  const opened = await Result.tryPromise({
    try: async () => await open(path.join(folder, "SKILL.md"), "r"),
    catch: (): SkillFileUnreadable => ({ reason: "unreadable" }),
  });
  if (opened.isErr()) {
    return Result.err(opened.error);
  }
  const file = opened.value;
  const read = await Result.tryPromise({
    try: async (): Promise<string | null> => {
      const { size } = await file.stat();
      return size > SKILL_FILE_MAX_BYTES
        ? null
        : await file.readFile({ encoding: "utf-8" });
    },
    catch: (): SkillFileUnreadable => ({ reason: "unreadable" }),
  });
  await file.close();
  if (read.isErr()) {
    return Result.err(read.error);
  }
  return read.value === null
    ? Result.err({ reason: "too_large" })
    : Result.ok(read.value);
};

/**
 * The hosts the turn's skill folders declare under `stella-network-hosts`:
 * the only hosts a sandboxed command may reach without the member being
 * asked. Read when the turn starts, as the folders are then; a skill whose
 * `SKILL.md` cannot be read or parsed, or whose declaration is malformed,
 * adds nothing.
 */
export const readSkillFolderNetworkHosts = async (
  folders: readonly HarnessSkillFolder[],
): Promise<SkillFolderNetworkHosts> => {
  const hosts = new Set<string>();
  const unreadable: string[] = [];
  for (const folder of folders) {
    const source = await readSkillFile(folder.path);
    const parsed = source.isErr() ? null : parseSkillFile(source.value);
    const declared =
      parsed === null || parsed.isErr()
        ? null
        : readSkillNetworkHosts(parsed.value.metadata.metadata);
    if (declared === null) {
      unreadable.push(folder.name);
      continue;
    }
    for (const host of declared) {
      hosts.add(host);
    }
  }
  return { hosts: [...hosts], unreadable };
};
