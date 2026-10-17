import { useInfiniteQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import type { BuiltInSkillId } from "@stll/skills";

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

type UseSkillsPagesOptions = {
  enabled?: boolean;
  organizationId: string;
  userId: string;
};

/** The skills list, with built-in rows titled in the reader's language. */
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
 * reader's language, ahead of any title stored with it; any other skill shows
 * its stored title, or its slug when none was stored.
 */
export const useSkillLabel = () => {
  const t = useTranslations();
  return (skill: SkillNames): string => {
    const copy =
      skill.skillId === undefined
        ? builtInSkillCopy(skill.skillName)
        : undefined;
    return copy === undefined
      ? (skill.skillDisplayName ?? skill.skillName)
      : t(copy.name);
  };
};
