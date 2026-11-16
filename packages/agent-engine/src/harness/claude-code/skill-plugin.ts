import { Result, TaggedError } from "better-result";
import { lstatSync } from "node:fs";
import {
  mkdir,
  readdir,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Temporal } from "temporal-polyfill/full";

import type { DetachedRejectionSink } from "@stll/errors";

import type { HarnessSkillFolder } from "../adapter";
import { loadableSkillFolders } from "../skill-folders";

/**
 * How a member's skill folders reach Claude Code: a plugin stella writes for
 * one turn, in its own configuration directory, whose `skills` entries link to
 * the folders. The pinned CLI loads no skills for `--add-dir` under
 * `--setting-sources ""`, and given a skill folder directly as `--plugin-dir`
 * it would also run that folder's `hooks`, register its `agents` and `commands`
 * and take its `plugin.json`. Through this plugin only the skill loads, and
 * nothing is ever written to the member's folder.
 */

const PLUGINS_FOLDER = "stella-skill-plugins";
/** The prefix skills carry in the CLI: `local-skills:<name>`. */
export const SKILL_PLUGIN_NAME = "local-skills";
/** Left by a holder that died mid-turn; no turn runs for this long. */
const STALE_AFTER_MS = Temporal.Duration.from({ hours: 168 }).total(
  "milliseconds",
);
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_FOLDER_MODE = 0o700;

export class SkillPluginFailed extends TaggedError("SkillPluginFailed")<{
  message: string;
  cause?: unknown;
}> {}

export type SkillPlugin = {
  /** What the CLI takes as `--plugin-dir`. */
  dir: string;
  /** The folders the plugin links to. */
  folders: readonly HarnessSkillFolder[];
};

/** What is at `target`, without following a link; nothing when unreachable. */
const entryAt = (target: string) =>
  Result.try(() => lstatSync(target, { throwIfNoEntry: false })).unwrapOr(
    undefined,
  );

const unlinkIfThere = async (target: string) => {
  if (entryAt(target) !== undefined) {
    await unlink(target);
  }
};

const rmdirIfThere = async (target: string) => {
  if (entryAt(target) !== undefined) {
    await rmdir(target);
  }
};

/**
 * Removes a plugin entry by entry and never recursively, so nothing here can
 * walk into a member's folder: only the plugin's own file and the links in its
 * real `skills` directory are unlinked, and anything else stops the removal
 * when a directory it is in will not go. A link in `skills`' place is unlinked,
 * never listed.
 */
export const removeSkillPlugin = async (dir: string) =>
  Result.tryPromise({
    try: async () => {
      await unlinkIfThere(path.join(dir, ".claude-plugin", "plugin.json"));
      await rmdirIfThere(path.join(dir, ".claude-plugin"));
      const skills = path.join(dir, "skills");
      const entry = entryAt(skills);
      if (entry?.isSymbolicLink() === true) {
        await unlink(skills);
      } else if (entry !== undefined) {
        const names = await readdir(skills);
        await Promise.all(
          names
            .map((name) => path.join(skills, name))
            .filter((link) => entryAt(link)?.isSymbolicLink() === true)
            .map(async (link) => unlink(link)),
        );
        await rmdir(skills);
      }
      await rmdirIfThere(dir);
    },
    catch: (cause) =>
      new SkillPluginFailed({
        message: "A skill plugin could not be removed.",
        cause,
      }),
  });

const removeStalePlugins = async (root: string, now: number) => {
  const entries = await readdir(root);
  return await Promise.all(
    entries
      .map((entry) => path.join(root, entry))
      .filter((dir) => {
        const stat = entryAt(dir);
        return (
          stat?.isDirectory() === true && now - stat.mtimeMs > STALE_AFTER_MS
        );
      })
      .map(async (dir) => removeSkillPlugin(dir)),
  );
};

type SkillLink = (target: string, link: string) => Promise<void>;

type OpenSkillPlugin = {
  configDir: string;
  folders: readonly HarnessSkillFolder[];
  platform: NodeJS.Platform;
  onBackgroundError: DetachedRejectionSink;
  /** How a folder is linked and the manifest written; a test can fail one. */
  link?: SkillLink;
  write?: (file: string, contents: string) => Promise<void>;
};

const platformLink =
  (platform: NodeJS.Platform): SkillLink =>
  async (target, link) =>
    // A junction needs no privilege on Windows; a symlink does.
    symlink(target, link, platform === "win32" ? "junction" : "dir");

/**
 * Writes the plugin for one turn, or answers `null` when no folder is left to
 * load. A fresh directory each turn, so nothing an earlier turn changed in one
 * is loaded by the next. A folder that cannot be linked is left out, as one
 * that vanished is, and never costs the turn.
 */
export const openSkillPlugin = async ({
  configDir,
  folders,
  platform,
  onBackgroundError,
  link = platformLink(platform),
  write = async (file, contents) =>
    writeFile(file, contents, { mode: PRIVATE_FILE_MODE }),
}: OpenSkillPlugin): Promise<Result<SkillPlugin | null, SkillPluginFailed>> => {
  const loadable = await loadableSkillFolders(folders);
  if (loadable.length === 0) {
    return Result.ok(null);
  }
  const root = path.join(configDir, PLUGINS_FOLDER);
  const dir = path.join(root, crypto.randomUUID());
  const report = (error: unknown, what: string) => {
    onBackgroundError(error, `skillPlugin.${what}`);
  };
  const remove = async () => {
    const removed = await removeSkillPlugin(dir);
    if (Result.isError(removed)) {
      report(removed.error, "remove");
    }
  };
  const written = await Result.tryPromise({
    try: async () => {
      await mkdir(path.join(dir, ".claude-plugin"), {
        recursive: true,
        mode: PRIVATE_FOLDER_MODE,
      });
      await mkdir(path.join(dir, "skills"), { mode: PRIVATE_FOLDER_MODE });
      await write(
        path.join(dir, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: SKILL_PLUGIN_NAME }),
      );
      // await-in-loop: two links must not race for one name.
      const linked: HarnessSkillFolder[] = [];
      for (const folder of loadable) {
        const made = await Result.tryPromise(async () =>
          link(folder.path, path.join(dir, "skills", folder.name)),
        );
        if (Result.isOk(made)) {
          linked.push(folder);
        } else {
          report(made.error, "link");
        }
      }
      // A stale plugin that stays costs nothing; the turn goes on without it.
      const removed = await removeStalePlugins(
        root,
        Temporal.Now.instant().epochMilliseconds,
      );
      for (const outcome of removed) {
        if (Result.isError(outcome)) {
          report(outcome.error, "removeStale");
        }
      }
      return linked;
    },
    catch: (cause) =>
      new SkillPluginFailed({
        message: "The skill folders could not be prepared for the harness.",
        cause,
      }),
  });
  if (Result.isError(written)) {
    await remove();
    return written;
  }
  if (written.value.length === 0) {
    await remove();
    return Result.ok(null);
  }
  return Result.ok({ dir, folders: written.value });
};

/** A path as the CLI's permission rules name it: from the root, POSIX style. */
const rulePath = (target: string, platform: NodeJS.Platform) => {
  const posix =
    platform === "win32"
      ? target
          .replaceAll("\\", "/")
          .replace(
            /^([A-Za-z]):/u,
            (_whole, drive: string) => `/${drive.toLowerCase()}`,
          )
      : target;
  const literal = posix.replaceAll(
    /[\\()*?[\]]/gu,
    (special) => `\\${special}`,
  );
  return `/${literal}/**`;
};

/**
 * What a run may do with its skill folders, as permission rules: read them
 * without asking, by the plugin's links and by their real paths, and never
 * edit them. The commands a skill runs are not file tools: `sandboxDenyWrite`
 * keeps those out of the folders in the sandbox.
 */
export const skillPluginPermissions = (
  { dir, folders }: SkillPlugin,
  platform: NodeJS.Platform,
) => {
  const paths = [dir, ...folders.map(({ path: folder }) => folder)].map(
    (target) => rulePath(target, platform),
  );
  return {
    allow: paths.map((target) => `Read(${target})`),
    deny: paths.map((target) => `Edit(${target})`),
  };
};
