import { BUILT_IN_SKILL_ORIGIN } from "./inspector-store-types";
import type { SkillResourceSource } from "./inspector-store-types";

type SkillListRow = { id: string; name: string; slug: string };

type SkillListPage = {
  builtIn: readonly SkillListRow[];
  installed: readonly SkillListRow[];
};

/**
 * The title the skills list gives the skill a resource came from: a built-in
 * by its slug, which every page repeats, and an installed skill by its row id.
 * `undefined` while the list is not loaded or once it no longer has the skill,
 * and the caller then shows the slug.
 */
export const findSkillDisplayName = ({
  pages,
  skillName,
  source,
}: {
  pages: readonly SkillListPage[] | undefined;
  skillName: string;
  source: SkillResourceSource;
}): string | undefined => {
  if (pages === undefined) {
    return undefined;
  }
  if (source.origin === BUILT_IN_SKILL_ORIGIN) {
    return pages.at(0)?.builtIn.find((row) => row.slug === skillName)?.name;
  }
  return pages
    .flatMap((page) => page.installed)
    .find((row) => row.id === source.skillId)?.name;
};
