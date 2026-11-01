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
