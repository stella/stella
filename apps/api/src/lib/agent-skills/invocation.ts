import type { SkillInvocation } from "@stll/skills/frontmatter";

import type { AgentSkillInvocation } from "@/api/db/schema";

/**
 * Whether the model may pick a skill by itself (`auto`) or the skill runs only
 * when the user invokes it (`manual`): a skill reference in the message, the
 * slash menu, or the thread's active skill.
 */
export const SKILL_INVOCATION = {
  auto: "auto",
  manual: "manual",
} as const satisfies Record<AgentSkillInvocation, AgentSkillInvocation>;

// The stored column and the SKILL.md value are one list.
true satisfies [AgentSkillInvocation] extends [SkillInvocation]
  ? [SkillInvocation] extends [AgentSkillInvocation]
    ? true
    : false
  : false;

declare const modelOfferedSkillsBrand: unique symbol;

/**
 * A skill catalog the model may see and load from. Only `offerSkillsToModel`
 * makes one, so every surface that hands skills to a model (the chat prompt
 * and its skill tools, one-shot generators, the MCP gateway) applies the
 * invocation rule by construction rather than by remembering to.
 */
export type ModelOfferedSkills<TSkill> = readonly TSkill[] & {
  readonly [modelOfferedSkillsBrand]: true;
};

type OfferableSkill = {
  /** Absent means unknown, which is offered only when invoked. */
  invocation?: SkillInvocation | undefined;
  name: string;
};

/**
 * The skills the model may use this turn: every `auto` skill, plus the ones
 * the user invoked explicitly (`invokedSkillNames`, by slug). A `manual`
 * skill outside that set is left out, so the model can neither see it in the
 * catalog nor load it by guessing its slug; the skill tools resolve names
 * against this list only.
 */
export const offerSkillsToModel = <TSkill extends OfferableSkill>({
  invokedSkillNames,
  skills,
}: {
  invokedSkillNames: ReadonlySet<string>;
  skills: readonly TSkill[];
}): ModelOfferedSkills<TSkill> =>
  brandModelOfferedSkills(
    skills.filter(
      (skill) =>
        skill.invocation === SKILL_INVOCATION.auto ||
        invokedSkillNames.has(skill.name),
    ),
  );

/**
 * Whether the model may start this skill with no invocation from the user,
 * for a surface where every call is the model's own pick (an MCP tool call).
 * The same rule as `offerSkillsToModel` with nothing invoked.
 */
export const modelMayStartUninvoked = (skill: OfferableSkill): boolean =>
  offerSkillsToModel({ invokedSkillNames: new Set(), skills: [skill] })
    .length === 1;

/** A narrower offer stays an offer: filtering never adds a skill. */
export const narrowModelOfferedSkills = <TSkill>(
  skills: ModelOfferedSkills<TSkill>,
  keep: (skill: TSkill) => boolean,
): ModelOfferedSkills<TSkill> => brandModelOfferedSkills(skills.filter(keep));

/** The empty offer, for surfaces that serve no skills. */
export const noModelOfferedSkills = <TSkill>(): ModelOfferedSkills<TSkill> =>
  brandModelOfferedSkills<TSkill>([]);

const brandModelOfferedSkills = <TSkill>(
  skills: readonly TSkill[],
): ModelOfferedSkills<TSkill> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the brand is minted here only, after the invocation filter
  skills as ModelOfferedSkills<TSkill>;
