import { describe, expect, test } from "bun:test";

import { getSkillResourceKind, parseSkillFile } from "./loader";

describe("Stella skill loader", () => {
  test("parses standard Agent Skills metadata fields", () => {
    const parsed = parseSkillFile(`---
name: imported-skill
description: Use when reviewing imported skills: validate metadata.
license: Apache-2.0
compatibility: Works with SKILL.md-compatible agents
metadata:
  author: stella
  version: "1.2.3"
---

Follow the process.`);

    expect(parsed.metadata).toEqual({
      compatibility: "Works with SKILL.md-compatible agents",
      description: "Use when reviewing imported skills: validate metadata.",
      license: "Apache-2.0",
      metadata: {
        author: "stella",
        version: "1.2.3",
      },
      name: "imported-skill",
      version: "1.2.3",
    });
    expect(parsed.body).toBe("Follow the process.");
  });

  test("parses skill files with CRLF line endings", () => {
    const parsed = parseSkillFile(
      [
        "---",
        "name: windows-skill",
        "description: Skill authored with CRLF delimiters.",
        "---",
        "",
        "Follow the Windows-authored process.",
      ].join("\r\n"),
    );

    expect(parsed.metadata.name).toBe("windows-skill");
    expect(parsed.metadata.description).toBe(
      "Skill authored with CRLF delimiters.",
    );
    expect(parsed.body).toBe("Follow the Windows-authored process.");
  });

  test("classifies common Agent Skills resource roots", () => {
    expect(getSkillResourceKind("references/checklist.md")).toBe("reference");
    expect(getSkillResourceKind("assets/template.txt")).toBe("asset");
    expect(getSkillResourceKind("scripts/helper.py")).toBe("script");
    expect(getSkillResourceKind("unknown/file.md")).toBeNull();
  });
});
