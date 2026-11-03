import { useInfiniteQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import type { BuiltInSkillId } from "@stll/skills";
import { STARTER_SKILLS } from "@stll/skills/starter-skills";
import type { StarterSkillSlug } from "@stll/skills/starter-skills";

import type { TranslationKey } from "@/i18n/types";
import { skillsOptions } from "@/lib/knowledge/queries";

/**
 * The title and description people read for each built-in skill. The API
 * serves the English title and the description written for the model; the
 * web app shows these instead, in the reader's language.
 */
export const BUILT_IN_SKILL_COPY = {
  "playbook-builder": {
    name: "knowledge.agentSkills.builtIn.playbookBuilder.name",
    description: "knowledge.agentSkills.builtIn.playbookBuilder.description",
  },
} as const satisfies Record<
  BuiltInSkillId,
  { name: TranslationKey; description: TranslationKey }
>;

const isBuiltInSkillId = (skillName: string): skillName is BuiltInSkillId =>
  Object.hasOwn(BUILT_IN_SKILL_COPY, skillName);

// `undefined` for a built-in this build does not ship, which the API can
// serve while a deploy rolls out: the row then keeps the title it came with.
const builtInSkillCopy = (skillName: string) =>
  isBuiltInSkillId(skillName) ? BUILT_IN_SKILL_COPY[skillName] : undefined;

/**
 * What each starter skill reads in the reader's language. The row a member
 * owns keeps the English it was seeded with, so a value still equal to that
 * English has not been edited; anything else is the member's own text.
 */
export const STARTER_SKILL_COPY = {
  "summarize-default": {
    name: "knowledge.agentSkills.starter.summarize.name",
    description: "knowledge.agentSkills.starter.summarize.description",
    body: "knowledge.agentSkills.starter.summarize.body",
  },
  "risks-default": {
    name: "knowledge.agentSkills.starter.risks.name",
    description: "knowledge.agentSkills.starter.risks.description",
    body: "knowledge.agentSkills.starter.risks.body",
  },
  "compare-default": {
    name: "knowledge.agentSkills.starter.compare.name",
    description: "knowledge.agentSkills.starter.compare.description",
    body: "knowledge.agentSkills.starter.compare.body",
  },
  "draft-default": {
    name: "knowledge.agentSkills.starter.draft.name",
    description: "knowledge.agentSkills.starter.draft.description",
    body: "knowledge.agentSkills.starter.draft.body",
  },
} as const satisfies Record<
  StarterSkillSlug,
  { name: TranslationKey; description: TranslationKey; body: TranslationKey }
>;

type StarterSkillCopy = (typeof STARTER_SKILL_COPY)[StarterSkillSlug];

type StarterSkillTranslate = (
  key: StarterSkillCopy[keyof StarterSkillCopy],
) => string;

// A rename gives a skill a new slug, so a renamed starter finds nothing here
// and shows what is stored.
const findStarterSkill = (slug: string) => {
  const seed = STARTER_SKILLS.find((skill) => skill.slug === slug);
  return seed === undefined
    ? undefined
    : { seed, copy: STARTER_SKILL_COPY[seed.slug] };
};

/**
 * A starter skill's text in the reader's language, field by field, so editing
 * one field keeps that edit and leaves the others translated. Only for showing
 * or inserting: the stored row is never written back.
 */
export const localizeStarterSkill = <
  TRow extends {
    body?: string | null;
    description: string;
    name: string;
    slug: string;
  },
>(
  row: TRow,
  t: StarterSkillTranslate,
): TRow => {
  const starter = findStarterSkill(row.slug);
  if (starter === undefined) {
    return row;
  }
  const { copy, seed } = starter;
  return {
    ...row,
    ...(row.name === seed.name && { name: t(copy.name) }),
    ...(row.description === seed.description && {
      description: t(copy.description),
    }),
    ...(row.body === seed.body && { body: t(copy.body) }),
  };
};

type UseSkillsPagesOptions = {
  enabled?: boolean;
  organizationId: string;
  userId: string;
};

/** The skills list, with stella's own text in the reader's language. */
export const useSkillsPages = ({
  enabled = true,
  organizationId,
  userId,
}: UseSkillsPagesOptions) => {
  const t = useTranslations();
  return useInfiniteQuery({
    ...skillsOptions(organizationId, userId),
    enabled,
    select: (data) => ({
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        builtIn: page.builtIn.map((row) => {
          const copy = builtInSkillCopy(row.slug);
          return copy === undefined
            ? row
            : {
                ...row,
                name: t(copy.name),
                description: t(copy.description),
              };
        }),
        installed: page.installed.map((row) =>
          row.origin === "default" ? localizeStarterSkill(row, t) : row,
        ),
      })),
    }),
  });
};

type SkillNames = {
  /** Absent for a built-in skill, which has no row. */
  skillId?: string | undefined;
  /** The skill's identifier (its slug). */
  skillName: string;
  /** The title stored with the skill, when one was. */
  skillDisplayName?: string | undefined;
};

/**
 * What a skill is called on screen. A built-in takes its title from the
 * reader's language, ahead of any title stored with it, and so does a starter
 * skill nobody has renamed; any other skill shows its stored title, or its slug
 * when none was stored.
 */
export const useSkillLabel = () => {
  const t = useTranslations();
  return (skill: SkillNames): string => {
    const copy =
      skill.skillId === undefined
        ? builtInSkillCopy(skill.skillName)
        : undefined;
    if (copy !== undefined) {
      return t(copy.name);
    }
    const starter = findStarterSkill(skill.skillName);
    return starter !== undefined && skill.skillDisplayName === starter.seed.name
      ? t(starter.copy.name)
      : (skill.skillDisplayName ?? skill.skillName);
  };
};
