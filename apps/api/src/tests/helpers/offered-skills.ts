import { offerSkillsToModel } from "@/api/lib/agent-skills/invocation";
import type { ModelOfferedSkills } from "@/api/lib/agent-skills/invocation";

/**
 * A turn catalog offering every given skill, as if the user had invoked each
 * one, so a fixture needs no invocation setting. Tests of the invocation rule
 * itself call `offerSkillsToModel` directly.
 */
export const offeredSkillCatalog = <TSkill extends { name: string }>(
  skills: readonly TSkill[],
): ModelOfferedSkills<TSkill> =>
  offerSkillsToModel({
    invokedSkillNames: new Set(skills.map(({ name }) => name)),
    skills,
  });
