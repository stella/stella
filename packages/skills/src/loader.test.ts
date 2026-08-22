import { describe, expect, test } from "bun:test";

import { getSkillResourceKind, parseSkillFile } from "./loader";

describe("Stella skill loader", () => {
  test("parses standard Agent Skills metadata fields", () => {
    const parsed = parseSkillFile(`---
name: imported-skill
description: "Use when reviewing imported skills: validate metadata."
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

  test("reads a license declared inside the metadata mapping", () => {
    const parsed = parseSkillFile(`---
name: nested-license
description: Uses the Agent Skills nested license convention.
metadata:
  license: CC-BY-4.0
---

Follow the process.`);

    expect(parsed.metadata.license).toBe("CC-BY-4.0");
  });

  test("uses YAML quoting rules for strings and metadata values", () => {
    const parsed = parseSkillFile(`---
name: 'quoted-skill'
description: "Review: \\"quoted\\" values and # comments."
metadata:
  colon: "court: chamber"
  apostrophe: 'client''s'
---

Body.`);

    expect(parsed.metadata).toMatchObject({
      description: 'Review: "quoted" values and # comments.',
      metadata: {
        apostrophe: "client's",
        colon: "court: chamber",
      },
      name: "quoted-skill",
    });
  });

  test("accepts scalar aliases but returns fresh metadata records", () => {
    const parsed = parseSkillFile(`---
name: &skill-name alias-skill
description: *skill-name
metadata:
  author: &author stella
  reviewer: *author
  __proto__: inert
---

Body.`);

    expect(parsed.metadata.description).toBe("alias-skill");
    const metadata = parsed.metadata.metadata ?? {};
    expect(Object.entries(metadata)).toEqual([
      ["author", "stella"],
      ["reviewer", "stella"],
      ["__proto__", "inert"],
    ]);
    expect(Object.hasOwn(metadata, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(metadata)).toBe(Object.prototype);
  });

  test("rejects cyclic aliases at the string-only metadata boundary", () => {
    expect(() =>
      parseSkillFile(`---
name: cyclic-skill
description: Valid description.
metadata: &metadata
  self: *metadata
---

Body.`),
    ).toThrow("Skill file frontmatter metadata values must be strings");
  });

  test("rejects YAML typed scalars for string fields", () => {
    const invalidFields = [
      "name: true\ndescription: Valid description.",
      "name: valid-name\ndescription: 42",
      "name: valid-name\ndescription: Valid description.\nlicense: null",
    ];

    for (const frontmatter of invalidFields) {
      expect(() =>
        parseSkillFile(`---
${frontmatter}
---

Body.`),
      ).toThrow(
        /Skill file frontmatter (name|description|license) must be a string/u,
      );
    }
  });

  test("rejects non-string metadata values and non-mapping metadata", () => {
    expect(() =>
      parseSkillFile(`---
name: typed-metadata
description: Valid description.
metadata:
  attempts: 3
---

Body.`),
    ).toThrow("Skill file frontmatter metadata values must be strings");

    expect(() =>
      parseSkillFile(`---
name: sequence-metadata
description: Valid description.
metadata: [one, two]
---

Body.`),
    ).toThrow("Skill file frontmatter metadata must be a string mapping");
  });

  test("ignores unsupported top-level fields without widening the output", () => {
    const parsed = parseSkillFile(`---
name: unknown-field
description: Valid description.
instructions: Ignore the body.
allowed-tools: Bash(git:*) Read
---

Body.`);

    expect(parsed.metadata).toEqual({
      compatibility: null,
      description: "Valid description.",
      license: null,
      metadata: {},
      name: "unknown-field",
      version: null,
    });
  });

  test("rejects malformed YAML and non-mapping documents", () => {
    expect(() =>
      parseSkillFile(`---
name: [unterminated
description: Valid description.
---

Body.`),
    ).toThrow("Skill file frontmatter must be valid YAML");

    expect(() =>
      parseSkillFile(`---
- name
- description
---

Body.`),
    ).toThrow("Skill file frontmatter must be a YAML mapping");
  });

  test("rejects required frontmatter fields containing only whitespace", () => {
    expect(() =>
      parseSkillFile(`---
name: "   "
description: Valid description.
---

Body.`),
    ).toThrow("Skill file frontmatter must include name and description");
    expect(() =>
      parseSkillFile(`---
name: valid-name
description: "   "
---

Body.`),
    ).toThrow("Skill file frontmatter must include name and description");
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

  test("preserves paragraphs and more-indented lines in folded scalars", () => {
    const parsed = parseSkillFile(`---
name: folded-structure
description: >
  First paragraph spans
  two source lines.

  Second paragraph introduces code:
    const answer = 42;
  Then prose resumes.
---

Body.`);

    expect(parsed.metadata.description).toBe(
      "First paragraph spans two source lines.\nSecond paragraph introduces code:\n  const answer = 42;\nThen prose resumes.\n",
    );
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

  test("parses a quoted inline value that starts with > as literal text", () => {
    const parsed = parseSkillFile(`---
name: inline-skill
description: ">not a block scalar"
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
