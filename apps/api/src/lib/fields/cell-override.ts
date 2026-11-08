import type { AiCellSettlement } from "@stll/api-contract";

import type {
  CellMetadata,
  CellOverride,
  FieldContent,
  MachineCellValue,
} from "@/api/db/schema-validators";

/**
 * A person's value over a machine one, kept in the cell's metadata.
 *
 * Every writer of a cell's metadata rebuilds the object from its own fields
 * (flags, lock), so the override is carried through `carriedCellMetadata`
 * rather than re-listed at each site; a writer that forgot it would silently
 * drop the machine original.
 */

/** The metadata a flag or lock change keeps exactly as it found it. */
export const carriedCellMetadata = (
  existing: CellMetadata | undefined,
): Pick<CellMetadata, "override"> => {
  const override = existing?.override;
  return override === undefined ? {} : { override };
};

/** Whether the metadata row must stay even with no flag and no lock. */
export const hasCarriedCellMetadata = (
  existing: CellMetadata | undefined,
): boolean => existing?.override !== undefined;

/**
 * A run's settlement that left something a person can overwrite: a value, or
 * the finding that the source does not state one. A failure or refusal left
 * nothing to keep.
 */
const isMachineOutcome = (
  settlement: AiCellSettlement | null,
): settlement is Extract<AiCellSettlement, { type: "value" | "notStated" }> =>
  settlement?.type === "value" || settlement?.type === "notStated";

type ReplacedField = {
  content: FieldContent;
  aiSettlement: AiCellSettlement | null;
  justification: MachineCellValue["justification"];
};

type NextCellOverrideArgs = {
  existing: CellOverride | undefined;
  /** The field row the manual write replaces; undefined when the cell is empty. */
  replaced: ReplacedField | undefined;
  editedBy: string;
  editedAt: string;
};

/**
 * The override after a person writes the cell. Replacing a run's outcome
 * captures it; replacing a person's value keeps the machine original already
 * captured and records the latest editor; a cell no run ever settled has none.
 */
export const nextCellOverride = ({
  existing,
  replaced,
  editedBy,
  editedAt,
}: NextCellOverrideArgs): CellOverride | undefined => {
  const settlement = replaced?.aiSettlement ?? null;
  if (replaced !== undefined && isMachineOutcome(settlement)) {
    return {
      machine: {
        content: replaced.content,
        settlement,
        justification: replaced.justification,
      },
      editedBy,
      editedAt,
      reason: null,
    };
  }
  if (existing === undefined) {
    return undefined;
  }
  return {
    machine: existing.machine,
    editedBy,
    editedAt,
    reason: existing.reason,
  };
};

/**
 * The override that still describes the cell. A run that settles the cell
 * again (after a person unlocked it) supersedes the person's value, so a
 * settlement on the current field makes any stored override stale.
 */
export const activeCellOverride = ({
  metadata,
  aiSettlement,
}: {
  metadata: CellMetadata | undefined;
  aiSettlement: AiCellSettlement | null | undefined;
}): CellOverride | undefined =>
  aiSettlement === null || aiSettlement === undefined
    ? metadata?.override
    : undefined;
