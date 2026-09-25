// A skill is invoked in chat via /its-command; suggest the skill's name as that
// command by default (lowercase, hyphenated) so the field reads as /skill-name.
// Diacritics are decomposed and stripped first so a name like "Česká dovednost"
// suggests "ceska-dovednost" rather than dropping the accented letters.
const slugifyCommand = (name: string): string =>
  name
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replace(/^-/u, "")
    .replace(/-$/u, "");

type SkillMetadataSnapshot = {
  command: string | null;
  description: string;
  enabled: boolean;
  id: string;
  name: string;
};

/** The skill editor's editable header fields. */
export type SkillMetadataDraft = {
  command: string;
  description: string;
  enabled: boolean;
  name: string;
};

/** The draft a server snapshot shows before the user edits anything. */
export const skillMetadataDraft = (
  snapshot: SkillMetadataSnapshot,
): SkillMetadataDraft => ({
  command: snapshot.command ?? slugifyCommand(snapshot.name),
  description: snapshot.description,
  enabled: snapshot.enabled,
  name: snapshot.name,
});

type RebaseSkillMetadataDraftOptions = {
  draft: SkillMetadataDraft;
  next: SkillMetadataSnapshot;
  previous: SkillMetadataSnapshot;
};

/**
 * The draft once a new server snapshot arrives. A field the user left as the
 * previous snapshot showed it follows the new snapshot; a field the user has
 * changed keeps their value, so saving one field (which refetches the skill)
 * never discards unsaved text in another. A snapshot of another skill (the
 * editor navigated) replaces the draft.
 */
export const rebaseSkillMetadataDraft = ({
  draft,
  next,
  previous,
}: RebaseSkillMetadataDraftOptions): SkillMetadataDraft => {
  if (next.id !== previous.id) {
    return skillMetadataDraft(next);
  }
  const shown = skillMetadataDraft(previous);
  const incoming = skillMetadataDraft(next);
  return {
    command: draft.command === shown.command ? incoming.command : draft.command,
    description:
      draft.description === shown.description
        ? incoming.description
        : draft.description,
    enabled: draft.enabled === shown.enabled ? incoming.enabled : draft.enabled,
    name: draft.name === shown.name ? incoming.name : draft.name,
  };
};
