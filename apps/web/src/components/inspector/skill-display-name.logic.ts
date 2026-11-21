type SkillListPage = {
  installed: readonly { id: string; name: string }[];
};

/**
 * The title the skills list gives an installed skill, by its row id, on any
 * page. `undefined` while the list is not loaded or once it no longer has the
 * skill, and the caller then shows the slug.
 */
export const findInstalledSkillDisplayName = ({
  pages,
  skillId,
}: {
  pages: readonly SkillListPage[] | undefined;
  skillId: string;
}): string | undefined =>
  pages?.flatMap((page) => page.installed).find((row) => row.id === skillId)
    ?.name;
