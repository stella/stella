import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  SKILL_REQUIRED_TOOLS_MAX,
  SKILL_REQUIRED_TOOLS_METADATA_KEY,
} from "@stll/skills";

import {
  filterSkillsWithAvailableTools,
  resolveSkillToolAvailability,
} from "@/api/lib/agent-skills/required-tools";
import {
  skillRequirableToolNames,
  validateSkillRequiredTools,
} from "@/api/lib/agent-skills/required-tools-validation";

const requiring = (value: string) => ({
  [SKILL_REQUIRED_TOOLS_METADATA_KEY]: value,
});

const errorMessage = (metadata: Record<string, string>) => {
  const result = validateSkillRequiredTools(metadata);
  return Result.isError(result) ? result.error.message : null;
};

describe("validateSkillRequiredTools", () => {
  test("accepts registry tools and chat's own tools", () => {
    expect(errorMessage(requiring("save_playbook list_playbooks"))).toBeNull();
    expect(errorMessage(requiring("ask-user"))).toBeNull();
    expect(errorMessage({})).toBeNull();
  });

  test("refuses a name stella has no tool for, naming it", () => {
    const message = errorMessage(requiring("save_playbook save_playbok"));

    expect(message).toContain("save_playbok");
    expect(message).not.toContain("save_playbook,");
  });

  test("refuses the skill tools themselves, which exist only because skills do", () => {
    expect(skillRequirableToolNames().has("load-skill")).toBe(false);
    expect(errorMessage(requiring("load-skill"))).toContain("load-skill");
  });

  test("refuses more tools than the cap", () => {
    const names = [...skillRequirableToolNames()].slice(
      0,
      SKILL_REQUIRED_TOOLS_MAX + 1,
    );

    expect(names).toHaveLength(SKILL_REQUIRED_TOOLS_MAX + 1);
    expect(errorMessage(requiring(names.join(" ")))).toContain(
      `at most ${String(SKILL_REQUIRED_TOOLS_MAX)}`,
    );
    expect(
      errorMessage(
        requiring(names.slice(0, SKILL_REQUIRED_TOOLS_MAX).join(" ")),
      ),
    ).toBeNull();
  });
});

describe("resolveSkillToolAvailability", () => {
  test("is available only when every required tool is offered", () => {
    const metadata = requiring("save_playbook list_playbooks");

    expect(
      resolveSkillToolAvailability({
        metadata,
        offeredToolNames: new Set(["list_playbooks", "save_playbook", "x"]),
      }),
    ).toEqual({ status: "available" });
    expect(
      resolveSkillToolAvailability({
        metadata,
        offeredToolNames: new Set(["list_playbooks"]),
      }),
    ).toEqual({ status: "unavailable", missingTools: ["save_playbook"] });
  });

  test("a skill that requires nothing is available anywhere", () => {
    expect(
      resolveSkillToolAvailability({
        metadata: { author: "stella" },
        offeredToolNames: new Set(),
      }),
    ).toEqual({ status: "available" });
  });
});

describe("filterSkillsWithAvailableTools", () => {
  test("drops the skills whose tools the context lacks", () => {
    const skills = [
      { metadata: {}, name: "plain" },
      { metadata: requiring("save_playbook"), name: "playbook-builder" },
    ];

    expect(
      filterSkillsWithAvailableTools({
        offeredToolNames: () => new Set(["list_playbooks"]),
        skills,
      }).map(({ name }) => name),
    ).toEqual(["plain"]);
    expect(
      filterSkillsWithAvailableTools({
        offeredToolNames: () => new Set(["save_playbook"]),
        skills,
      }).map(({ name }) => name),
    ).toEqual(["plain", "playbook-builder"]);
  });

  test("does not resolve the context's tools when no skill requires any", () => {
    let resolved = false;

    filterSkillsWithAvailableTools({
      offeredToolNames: () => {
        resolved = true;
        return new Set();
      },
      skills: [{ metadata: {} }],
    });

    expect(resolved).toBe(false);
  });
});
