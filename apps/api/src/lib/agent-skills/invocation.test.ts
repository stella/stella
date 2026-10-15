import { describe, expect, test } from "bun:test";

import {
  modelMayStartUninvoked,
  narrowModelOfferedSkills,
  offerSkillsToModel,
  SKILL_INVOCATION,
} from "@/api/lib/agent-skills/invocation";

const auto = { invocation: SKILL_INVOCATION.auto, name: "auto-skill" };
const manual = { invocation: SKILL_INVOCATION.manual, name: "manual-skill" };
const unknown = { name: "unknown-skill" };

const names = (skills: readonly { name: string }[]) =>
  skills.map(({ name }) => name);

describe("offerSkillsToModel", () => {
  test("offers auto skills and leaves out manual ones nobody invoked", () => {
    expect(
      names(
        offerSkillsToModel({
          invokedSkillNames: new Set(),
          skills: [auto, manual],
        }),
      ),
    ).toEqual(["auto-skill"]);
  });

  test("offers a manual skill the user invoked by its slug", () => {
    expect(
      names(
        offerSkillsToModel({
          invokedSkillNames: new Set(["manual-skill"]),
          skills: [auto, manual],
        }),
      ),
    ).toEqual(["auto-skill", "manual-skill"]);
  });

  test("an invocation by another name does not unlock a manual skill", () => {
    expect(
      names(
        offerSkillsToModel({
          invokedSkillNames: new Set(["Manual-Skill", "manual"]),
          skills: [manual],
        }),
      ),
    ).toEqual([]);
  });

  test("a skill with no known invocation is offered only when invoked", () => {
    expect(
      names(
        offerSkillsToModel({ invokedSkillNames: new Set(), skills: [unknown] }),
      ),
    ).toEqual([]);
    expect(
      names(
        offerSkillsToModel({
          invokedSkillNames: new Set(["unknown-skill"]),
          skills: [unknown],
        }),
      ),
    ).toEqual(["unknown-skill"]);
  });

  test("narrowing an offer never adds a skill", () => {
    const offered = offerSkillsToModel({
      invokedSkillNames: new Set(),
      skills: [auto, manual],
    });
    expect(names(narrowModelOfferedSkills(offered, () => true))).toEqual([
      "auto-skill",
    ]);
  });
});

describe("modelMayStartUninvoked", () => {
  test("only an auto skill may start on the model's own call", () => {
    expect(modelMayStartUninvoked(auto)).toBe(true);
    expect(modelMayStartUninvoked(manual)).toBe(false);
    expect(modelMayStartUninvoked(unknown)).toBe(false);
  });
});
