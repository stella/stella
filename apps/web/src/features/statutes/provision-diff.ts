/** One consolidation's wording of a provision, as the history read returns it. */
type ProvisionVersion = {
  documentId: string;
  text: string;
};

/**
 * The versions in which a provision was actually rewritten, from a
 * newest-first run of its wording per consolidation.
 *
 * A consolidation that reissues a provision unchanged is not part of its
 * history, so it is folded away. The oldest wording in the run is always
 * kept: it is the earliest wording on record, not a repetition of anything.
 */
export const selectChangedVersions = <T extends ProvisionVersion>(
  versions: readonly T[],
): T[] =>
  versions.filter((version, index) => {
    const older = versions.at(index + 1);

    return older === undefined || older.text !== version.text;
  });

type ResolveSelectedVersionOptions<T extends ProvisionVersion> = {
  /** Every consolidation read so far, newest first, nothing folded away. */
  consolidations: readonly T[];
  /** The result of `selectChangedVersions` over them. */
  changed: readonly T[];
  selectedId: string | null;
};

/**
 * Which entry of the history a selection points at.
 *
 * The folded list is not stable across pages: loading older consolidations
 * can reveal that the selected one merely reissued the wording its
 * predecessor introduced, at which point folding drops it. Reading the
 * selection back by position would then silently jump to the newest entry, so
 * a dropped selection is resolved to the entry that represents its wording:
 * folding keeps the oldest consolidation of an equal-wording run, which is
 * the first kept entry at or below the selected one.
 */
export const resolveSelectedVersion = <T extends ProvisionVersion>({
  changed,
  consolidations,
  selectedId,
}: ResolveSelectedVersionOptions<T>): T | undefined => {
  const newest = changed.at(0);

  if (selectedId === null) {
    return newest;
  }

  const kept = new Set(changed.map((version) => version.documentId));

  if (kept.has(selectedId)) {
    return changed.find((version) => version.documentId === selectedId);
  }

  const selectedIndex = consolidations.findIndex(
    (version) => version.documentId === selectedId,
  );

  if (selectedIndex === -1) {
    return newest;
  }

  return (
    consolidations
      .slice(selectedIndex)
      .find((version) => kept.has(version.documentId)) ?? newest
  );
};
