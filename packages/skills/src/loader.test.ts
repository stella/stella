import { describe, expect, test } from "bun:test";

import {
  getSkillResourceKind,
  listSkillMetadata,
  listSkillResources,
  loadSkill,
  parseSkillFile,
  readSkillResource,
} from "./loader";

describe("Stella skill loader", () => {
  test("loads bundled skill metadata without loading full resources", () => {
    const metadata = listSkillMetadata();

    expect(metadata.map((skill) => skill.name)).toContain(
      "legal-interpretation",
    );
    expect(
      metadata.find((skill) => skill.name === "legal-interpretation")
        ?.description,
    ).toContain("Analyze legal documents");
    expect(
      metadata.find((skill) => skill.name === "legal-interpretation")?.version,
    ).toBe("3.0");
    expect(
      metadata.find((skill) => skill.name === "legal-interpretation")?.license,
    ).toBeNull();
  });

  test("loads a skill body and whitelisted resource manifest", () => {
    const skill = loadSkill("legal-interpretation");

    expect(skill.body).toContain("You are a legal analysis assistant");
    expect(skill.resources.map((resource) => resource.path)).toContain(
      "knowledge/01-interpretation-methods.md",
    );
  });

  test("reads only resources in the skill resource manifest", () => {
    const resources = listSkillResources("legal-interpretation");
    const firstResource = resources.at(0);

    expect(firstResource).toBeDefined();
    expect(
      readSkillResource({
        skillId: "legal-interpretation",
        resourcePath: firstResource?.path ?? "",
      }),
    ).toContain("##");
  });

  test("rejects traversal and non-resource paths", () => {
    expect(() =>
      readSkillResource({
        skillId: "legal-interpretation",
        resourcePath: "../case-briefing/SKILL.md",
      }),
    ).toThrow();
    expect(() =>
      readSkillResource({
        skillId: "legal-interpretation",
        resourcePath: "..",
      }),
    ).toThrow();
    expect(() =>
      readSkillResource({
        skillId: "legal-interpretation",
        resourcePath: "SKILL.md",
      }),
    ).toThrow();
  });

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
