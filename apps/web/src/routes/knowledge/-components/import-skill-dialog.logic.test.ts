import { describe, expect, test } from "bun:test";

import {
  listSkippedImportFiles,
  pickSkillPackFile,
  summarizeSkillImportFailures,
} from "./import-skill-dialog.logic";

describe("skill import failure summaries", () => {
  test("surfaces each distinct localized failure", () => {
    expect(
      summarizeSkillImportFailures(
        [
          { code: "fetch_failed" },
          { code: "name_conflict" },
          { code: "fetch_failed" },
        ],
        ({ code }) =>
          code === "fetch_failed"
            ? "Could not load the skill source"
            : "A skill with this name already exists",
        "Unexpected error",
      ),
    ).toBe(
      "Could not load the skill source; A skill with this name already exists",
    );
  });

  test("uses the fallback when localization returns no useful message", () => {
    expect(
      summarizeSkillImportFailures(
        [{ code: "fetch_failed" }],
        () => "  ",
        "Unexpected error",
      ),
    ).toBe("Unexpected error");
  });
});

describe("files an import left out", () => {
  test("names each left-out file after the skill it came from", () => {
    expect(
      listSkippedImportFiles({
        installed: [
          {
            sourceUrl: "https://example.test/b",
            skippedFiles: [
              { path: "notes/todo.md", reason: "unsupported-folder" },
              { path: "assets/logo.png", reason: "unsupported-extension" },
            ],
          },
          { sourceUrl: "https://example.test/a", skippedFiles: [] },
        ],
        skills: [
          { name: "alpha", sourceUrl: "https://example.test/a" },
          { name: "beta", sourceUrl: "https://example.test/b" },
        ],
      }),
    ).toEqual([
      {
        path: "assets/logo.png",
        reason: "unsupported-extension",
        skillName: "beta",
      },
      {
        path: "notes/todo.md",
        reason: "unsupported-folder",
        skillName: "beta",
      },
    ]);
  });

  test("names a skill the discovery no longer lists by its source URL", () => {
    expect(
      listSkippedImportFiles({
        installed: [
          {
            sourceUrl: "https://example.test/c",
            skippedFiles: [{ path: "README.md", reason: "unsupported-folder" }],
          },
        ],
        skills: [],
      }),
    ).toEqual([
      {
        path: "README.md",
        reason: "unsupported-folder",
        skillName: "https://example.test/c",
      },
    ]);
  });
});

describe("picking the skill pack from a drop", () => {
  const file = (name: string) => ({ name });

  test("installs a .zip pack, whatever else was dropped with it", () => {
    const pack = file("Apr-Replies.ZIP");
    expect(pickSkillPackFile([file("SKILL.md"), pack, file("notes.txt")])).toBe(
      pack,
    );
  });

  test("installs a markdown skill dropped on its own", () => {
    const skill = file("SKILL.md");
    expect(pickSkillPackFile([skill])).toBe(skill);
  });

  test("refuses a dropped folder without a .zip rather than install part of it", () => {
    expect(
      pickSkillPackFile([file("SKILL.md"), file("references/checks.md")]),
    ).toBeNull();
  });

  test("refuses a drop that holds no skill", () => {
    expect(pickSkillPackFile([file("brief.docx")])).toBeNull();
    expect(pickSkillPackFile([])).toBeNull();
  });
});
