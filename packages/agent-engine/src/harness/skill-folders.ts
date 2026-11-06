import { panic, Result } from "better-result";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import type { HarnessSkillFolder } from "./adapter";

/**
 * The skill folders a local run may load. The member lists them on their own
 * computer and the desktop checks them when it starts the run; a folder can
 * still change after that, so each is looked at again here, without following
 * a link. A folder that is gone or no longer holds a `SKILL.md` is left out:
 * the rest of the turn does not depend on it.
 *
 * A folder can sit on a mount that hangs, and this runs in the holder every run
 * shares, so each look has a budget and one that outlasts it counts as gone.
 *
 * A name is also a directory entry and part of a tool name, so it stays plain,
 * and must mean one entry on every file system a desktop runs on: two names
 * that differ only by case would collide, and Windows reserves some names and
 * drops a trailing dot.
 */
const SKILL_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9_-])?$/u;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/iu;
const SKILL_FILE = "SKILL.md";
const LOOK_BUDGET_MS = 2000;

const withinBudget = async <T>(look: Promise<T>, otherwise: T): Promise<T> =>
  Promise.race([look, Bun.sleep(LOOK_BUDGET_MS).then(() => otherwise)]);

const holdsSkill = async (folder: string) =>
  withinBudget(
    Result.tryPromise(async () => {
      const [entry, file] = await Promise.all([
        lstat(folder),
        lstat(path.join(folder, SKILL_FILE)),
      ]);
      return entry.isDirectory() && file.isFile();
    }).then((held) => Result.isOk(held) && held.value),
    false,
  );

const isPlainSkillName = (name: string) =>
  SKILL_NAME.test(name) && !WINDOWS_RESERVED_NAME.test(name);

export const loadableSkillFolders = async (
  folders: readonly HarnessSkillFolder[],
): Promise<HarnessSkillFolder[]> => {
  const held = await Promise.all(
    folders.map(async ({ name, path: folder }) => {
      if (!path.isAbsolute(folder)) {
        return panic("Skill folders: a skill folder must be an absolute path");
      }
      return isPlainSkillName(name) && (await holdsSkill(folder));
    }),
  );
  const names = new Set<string>();
  return folders.filter(({ name }, index) => {
    const key = name.toLowerCase();
    if (held[index] !== true || names.has(key)) {
      return false;
    }
    names.add(key);
    return true;
  });
};

/** Where a path really is; `null` when that cannot be told in time. */
export const realPathOf = async (target: string) =>
  withinBudget(
    Result.tryPromise(async () => realpath(target)).then((found) =>
      Result.isOk(found) ? found.value : null,
    ),
    null,
  );

/** Where a folder's own `SKILL.md` really is, or `null`. */
export const realSkillFile = async (folder: string) =>
  realPathOf(path.join(folder, SKILL_FILE));
