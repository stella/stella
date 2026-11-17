import { Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadableSkillFolders } from "../skill-folders";
import { openSkillPlugin, removeSkillPlugin } from "./skill-plugin";

const cleanups: (() => void)[] = [];
const reported: unknown[] = [];
afterEach(() => {
  reported.length = 0;
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

const place = () => {
  const root = mkdtempSync(path.join(tmpdir(), "stella-skill-plugin-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

const skillAt = (root: string, name: string, directory = name) => {
  const folder = path.join(root, directory);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, "SKILL.md"), `---\nname: ${name}\n---\n`);
  return { name, path: folder };
};

const options = (configDir: string) => ({
  configDir,
  platform: "darwin" as const,
  onBackgroundError: (error: unknown) => {
    reported.push(error);
  },
});

const pluginsIn = (configDir: string) =>
  readdirSync(path.join(configDir, "stella-skill-plugins"));

describe("the plugin a turn loads its skills through", () => {
  test("a folder that cannot be linked is left out and the turn keeps the rest", async () => {
    const root = place();
    const good = skillAt(root, "good-skill");
    const bad = skillAt(root, "bad-skill");
    const opened = await openSkillPlugin({
      ...options(path.join(root, "config")),
      folders: [bad, good],
      link: async (target, link) => {
        if (target === bad.path) {
          throw new Error("no link for you");
        }
        symlinkSync(target, link);
      },
    });
    if (Result.isError(opened) || opened.value === null) {
      throw new Error("the plugin should open with the folder that linked");
    }
    expect(opened.value.folders).toEqual([good]);
    expect(readdirSync(path.join(opened.value.dir, "skills"))).toEqual([
      good.name,
    ]);
    expect(reported).toHaveLength(1);
  });

  test("when no folder can be linked there is no plugin and nothing stays behind", async () => {
    const root = place();
    const config = path.join(root, "config");
    const opened = await openSkillPlugin({
      ...options(config),
      folders: [skillAt(root, "bad-skill")],
      link: async () => {
        throw new Error("no link for you");
      },
    });
    expect(Result.isOk(opened) && opened.value).toBeNull();
    expect(pluginsIn(config)).toEqual([]);
  });

  test("a plugin that cannot be written is refused and leaves nothing behind", async () => {
    const root = place();
    const config = path.join(root, "config");
    mkdirSync(path.join(config, "stella-skill-plugins"), { recursive: true });
    const opened = await openSkillPlugin({
      ...options(config),
      folders: [skillAt(root, "fixture-skill")],
      write: async () => {
        throw new Error("the disk is full");
      },
    });
    expect(Result.isError(opened)).toBe(true);
    expect(pluginsIn(config)).toEqual([]);
  });

  test("removing a plugin leaves the member's folder alone", async () => {
    const root = place();
    const skill = skillAt(root, "fixture-skill");
    const opened = await openSkillPlugin({
      ...options(path.join(root, "config")),
      folders: [skill],
    });
    if (Result.isError(opened) || opened.value === null) {
      throw new Error("the plugin should open");
    }
    expect(Result.isOk(await removeSkillPlugin(opened.value.dir))).toBe(true);
    expect(existsSync(opened.value.dir)).toBe(false);
    expect(readdirSync(skill.path)).toEqual(["SKILL.md"]);
  });

  test("a link in place of skills is unlinked and never listed", async () => {
    const root = place();
    const member = path.join(root, "member");
    mkdirSync(member);
    const memberFile = path.join(member, "notes.md");
    writeFileSync(memberFile, "keep");
    const memberLink = path.join(member, "a-link");
    symlinkSync(memberFile, memberLink);
    const dir = path.join(root, "plugin");
    mkdirSync(dir);
    symlinkSync(member, path.join(dir, "skills"));

    expect(Result.isOk(await removeSkillPlugin(dir))).toBe(true);

    expect(existsSync(dir)).toBe(false);
    expect(readdirSync(member).toSorted()).toEqual(["a-link", "notes.md"]);
  });

  test("anything but a link in skills stops the removal instead of going with it", async () => {
    const root = place();
    const dir = path.join(root, "plugin");
    const planted = path.join(dir, "skills", "planted");
    mkdirSync(planted, { recursive: true });
    writeFileSync(path.join(planted, "kept.md"), "keep");

    expect(Result.isError(await removeSkillPlugin(dir))).toBe(true);

    expect(existsSync(path.join(planted, "kept.md"))).toBe(true);
  });
});

describe("which folders a turn may load", () => {
  test("two names that differ only by case are one name", async () => {
    const root = place();
    const first = skillAt(root, "Contract-Review", "one");
    const second = skillAt(root, "contract-review", "two");
    expect(await loadableSkillFolders([first, second])).toEqual([first]);
  });

  test("a name Windows reserves or would change is refused on every system", async () => {
    const root = place();
    const folders = [
      "NUL",
      "con",
      "Aux.txt",
      "com1",
      "LPT9",
      "foo.",
      "foo...",
    ].map((name, index) => skillAt(root, name, `folder-${String(index)}`));
    expect(await loadableSkillFolders(folders)).toEqual([]);
  });

  test("a name that only resembles one stays usable", async () => {
    const root = place();
    const folders = ["console", "nullable", "com-review", "v1.2"].map(
      (name, index) => skillAt(root, name, `folder-${String(index)}`),
    );
    expect(await loadableSkillFolders(folders)).toEqual(folders);
  });
});
