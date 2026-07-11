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

  test("parses a folded (>) block scalar description into one spaced line", () => {
    const parsed = parseSkillFile(`---
name: folded-skill
description: >
  Use this skill when the matter spans several
  jurisdictions and needs a consolidated view.
license: MIT
---

Body.`);

    expect(parsed.metadata.description).toBe(
      "Use this skill when the matter spans several jurisdictions and needs a consolidated view.\n",
    );
    expect(parsed.metadata.license).toBe("MIT");
    expect(parsed.metadata.name).toBe("folded-skill");
  });

  test("strips the trailing newline for a folded-strip (>-) block scalar", () => {
    const parsed = parseSkillFile(`---
name: folded-strip-skill
description: >-
  First fragment
  second fragment.
---

Body.`);

    expect(parsed.metadata.description).toBe("First fragment second fragment.");
  });

  test("parses a literal (|) block scalar description preserving newlines", () => {
    const parsed = parseSkillFile(`---
name: literal-skill
description: |
  Line one.
  Line two.
---

Body.`);

    expect(parsed.metadata.description).toBe("Line one.\nLine two.\n");
  });

  test("strips the trailing newline for a literal-strip (|-) block scalar", () => {
    const parsed = parseSkillFile(`---
name: literal-strip-skill
description: |-
  Line one.
  Line two.
---

Body.`);

    expect(parsed.metadata.description).toBe("Line one.\nLine two.");
  });

  test("treats an inline value that merely starts with > as literal text", () => {
    const parsed = parseSkillFile(`---
name: inline-skill
description: >not a block scalar
---

Body.`);

    expect(parsed.metadata.description).toBe(">not a block scalar");
  });

  test("classifies common Agent Skills resource roots", () => {
    expect(getSkillResourceKind("references/checklist.md")).toBe("reference");
    expect(getSkillResourceKind("assets/template.txt")).toBe("asset");
    expect(getSkillResourceKind("scripts/helper.py")).toBe("script");
    expect(getSkillResourceKind("unknown/file.md")).toBeNull();
  });
});
