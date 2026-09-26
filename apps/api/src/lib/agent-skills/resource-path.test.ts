import { describe, expect, test } from "bun:test";

import { getSkillResourceKind } from "@stll/skills";

import { inferResourceKind } from "./resource-path";

const PACKAGE_FOLDER_PATHS = [
  "assets/logo.txt",
  "knowledge/glossary.md",
  "prompts/intake.prompt.md",
  "reference/terms.md",
  "references/checklist.md",
  "scripts/run.py",
  "templates/letter.md",
] as const;

describe("authored skill resource kinds", () => {
  test("a file in a package resource folder gets the kind a package import gives it", () => {
    for (const path of PACKAGE_FOLDER_PATHS) {
      const packageKind = getSkillResourceKind(path);
      expect(packageKind).not.toBeNull();
      expect(inferResourceKind(path)).toBe(packageKind ?? "asset");
    }
  });

  test("a file outside the package resource folders is an asset", () => {
    for (const path of ["notes.md", "misc/notes.md"]) {
      expect(getSkillResourceKind(path)).toBeNull();
      expect(inferResourceKind(path)).toBe("asset");
    }
  });
});
