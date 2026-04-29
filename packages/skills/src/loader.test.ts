import { describe, expect, test } from "bun:test";

import {
  listSkillMetadata,
  listSkillResources,
  loadSkill,
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
});
