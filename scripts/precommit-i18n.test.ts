import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runPrecommitI18n } from "./precommit-i18n";

// Dynamic reads consume temporary Git fixtures, never repository Markdown.
export const CI_MARKDOWN_READER_INPUTS = [] as const;

// Every git call names its own identity and reads no global or system
// config, so a developer machine behaves like a CI runner that has none.
const git = (cwd: string, ...args: string[]): string => {
  const result = Bun.spawnSync(
    ["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args],
    {
      cwd,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
};

const LANGS = "apps/web/src/i18n/langs";
const FILES = {
  en: `${LANGS}/en.json`,
  cs: `${LANGS}/cs.json`,
  types: `${LANGS}/messages.gen.ts`,
  terminology: "apps/web/src/i18n/TERMINOLOGY.md",
  prepaint: "apps/web/public/prepaint-init.js",
  unrelated: "apps/web/src/app.ts",
} as const;

const staged = (repo: string): string[] =>
  git(repo, "diff", "--cached", "--name-only").split("\n").filter(Boolean);
const unstaged = (repo: string): string[] =>
  git(repo, "diff", "--name-only").split("\n").filter(Boolean);

// A repository holding the sync's targets and one unrelated file, committed;
// the catalog edit en.json is staged as a commit would stage it.
const withRepo = (check: (repo: string) => void) => {
  // Outside the checkout, so repository checks walking the tree never see it.
  const repo = mkdtempSync(path.join(tmpdir(), "precommit-i18n-"));
  const write = (file: string, text: string) => {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), text);
  };
  try {
    git(repo, "init", "-q", "-b", "main");
    for (const file of Object.values(FILES)) {
      write(file, `${file} v1\n`);
    }
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "base");
    write(FILES.en, '{ "a": "A" }\n');
    git(repo, "add", FILES.en);
    check(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
};

const read = (repo: string, file: string) =>
  readFileSync(path.join(repo, file), "utf-8");

describe("pre-commit i18n sync", () => {
  test("stages every file the sync writes", () => {
    withRepo((repo) => {
      const result = runPrecommitI18n(repo, () => {
        writeFileSync(path.join(repo, FILES.cs), '{ "a": "A" }\n');
        writeFileSync(path.join(repo, FILES.types), "type Messages = {};\n");
        writeFileSync(path.join(repo, FILES.prepaint), "// locales\n");
        return 0;
      });
      expect(result).toEqual({
        kind: "staged",
        staged: [FILES.prepaint, FILES.cs, FILES.types].toSorted(),
      });
      expect(staged(repo).toSorted()).toEqual(
        [FILES.prepaint, FILES.en, FILES.cs, FILES.types].toSorted(),
      );
      expect(unstaged(repo)).toEqual([]);
    });
  });

  test("a target with unstaged changes refuses before the sync writes", () => {
    withRepo((repo) => {
      writeFileSync(path.join(repo, FILES.cs), "work in progress\n");
      let synced = false;
      const result = runPrecommitI18n(repo, () => {
        synced = true;
        writeFileSync(path.join(repo, FILES.cs), '{ "a": "A" }\n');
        return 0;
      });
      expect(result).toEqual({ kind: "refused", dirty: [FILES.cs] });
      expect(synced).toBe(false);
      expect(read(repo, FILES.cs)).toBe("work in progress\n");
      expect(staged(repo)).toEqual([FILES.en]);
    });
  });

  test("an untracked target refuses too", () => {
    withRepo((repo) => {
      const draft = `${LANGS}/fr.json`;
      writeFileSync(path.join(repo, draft), "{}\n");
      const result = runPrecommitI18n(repo, () => 0);
      expect(result).toEqual({ kind: "refused", dirty: [draft] });
      expect(staged(repo)).toEqual([FILES.en]);
    });
  });

  test("files the sync leaves alone are not staged", () => {
    withRepo((repo) => {
      writeFileSync(path.join(repo, FILES.unrelated), "unstaged edit\n");
      const result = runPrecommitI18n(repo, () => {
        // Rewriting a target with its current content is not a change.
        writeFileSync(
          path.join(repo, FILES.terminology),
          `${FILES.terminology} v1\n`,
        );
        writeFileSync(path.join(repo, FILES.cs), '{ "a": "A" }\n');
        return 0;
      });
      expect(result).toEqual({ kind: "staged", staged: [FILES.cs] });
      expect(staged(repo).toSorted()).toEqual([FILES.en, FILES.cs].toSorted());
      expect(unstaged(repo)).toEqual([FILES.unrelated]);
    });
  });

  test("a sync that writes outside its targets stages nothing", () => {
    withRepo((repo) => {
      const result = runPrecommitI18n(repo, () => {
        writeFileSync(path.join(repo, FILES.cs), '{ "a": "A" }\n');
        writeFileSync(path.join(repo, FILES.unrelated), "generated\n");
        return 0;
      });
      expect(result).toEqual({
        kind: "undeclared-writes",
        outside: [FILES.unrelated],
      });
      expect(staged(repo)).toEqual([FILES.en]);
    });
  });

  test("a failed sync stages nothing", () => {
    withRepo((repo) => {
      const result = runPrecommitI18n(repo, () => {
        writeFileSync(path.join(repo, FILES.cs), "half written\n");
        return 2;
      });
      expect(result).toEqual({ kind: "sync-failed", exitCode: 2 });
      expect(staged(repo)).toEqual([FILES.en]);
    });
  });
});
