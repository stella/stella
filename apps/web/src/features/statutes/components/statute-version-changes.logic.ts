import { STATUTE_PROVISION_CHANGE_KINDS } from "@stll/api-contract/statute-version-changes";
import type { StatuteChangeCounts } from "@stll/legal-ast/statute-compare";

type ProvisionChangeKind = (typeof STATUTE_PROVISION_CHANGE_KINDS)[number];

/** One part of a version's change line: a kind of change and how many. */
export type VersionChangePart = {
  kind: ProvisionChangeKind;
  count: number;
};

/**
 * The parts a version's change line names, in a fixed order, leaving out
 * every kind of change that did not happen. Empty when no provision changed.
 */
export const versionChangeParts = ({
  provisions,
}: StatuteChangeCounts): VersionChangePart[] =>
  STATUTE_PROVISION_CHANGE_KINDS.flatMap((kind) =>
    provisions[kind] === 0 ? [] : [{ kind, count: provisions[kind] }],
  );

/** Cells of the size bar, as a diff stat draws them. */
const VERSION_CHANGE_BAR_CELLS = 5;

export type VersionChangeBarCell = "inserted" | "deleted" | "empty";

/**
 * A rough size signal: how many words changed, on a logarithmic scale (one
 * cell for a word or two, all of them for thousands), filled with insertions
 * and deletions in proportion. Never a verdict on importance: one word can
 * be the amendment that matters, which is why the counts sit beside it.
 */
export const versionChangeBar = ({
  deleted,
  inserted,
}: StatuteChangeCounts["words"]): VersionChangeBarCell[] => {
  const total = inserted + deleted;
  const filled =
    total === 0
      ? 0
      : Math.min(
          VERSION_CHANGE_BAR_CELLS,
          Math.max(1, Math.ceil(Math.log10(total + 1))),
        );
  // Each side that changed keeps a cell of its own once there are two to
  // share, so a large insertion never hides that something was struck.
  const insertedCells =
    filled < 2 || inserted === 0 || deleted === 0
      ? Math.round((filled * inserted) / Math.max(total, 1))
      : Math.min(
          filled - 1,
          Math.max(1, Math.round((filled * inserted) / total)),
        );

  return Array.from(
    { length: VERSION_CHANGE_BAR_CELLS },
    (_, index): VersionChangeBarCell => {
      if (index < insertedCells) {
        return "inserted";
      }
      return index < filled ? "deleted" : "empty";
    },
  );
};
