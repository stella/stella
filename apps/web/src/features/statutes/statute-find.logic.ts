/**
 * The statute half of find-in-table: what each column of a statute row shows
 * a find. Like decisions, rows are found on the client over the page on
 * screen; the search box already narrowed the corpus.
 */

import type { StatuteListItem } from "@/features/statutes/queries/statutes";
import { statuteActLabel } from "@/features/statutes/statute-act-number";
import { STATUTE_COLUMN_IDS } from "@/features/statutes/statute-columns.logic";
import type { StatuteColumnId } from "@/features/statutes/statute-columns.logic";

type StatuteFindText = (statute: StatuteListItem) => string;

/**
 * The text each statute column shows a find, or null for a column a find
 * cannot reach. Dates and counts are drawn in the reader's locale and a
 * validity as its label, so the stored value is not the string on screen;
 * the filters narrow those instead.
 */
const STATUTE_FIND_TEXT = {
  // Both lines of the cell, each marked on its own.
  act: (statute) => {
    const { name, number } = statuteActLabel(statute);
    return [number, name].filter((part) => part !== null).join("\n");
  },
  type: (statute) => statute.documentType ?? "",
  validity: null,
  firstVersion: null,
  amendments: null,
  lastAmended: null,
  citedBy: null,
} as const satisfies Record<StatuteColumnId, StatuteFindText | null>;

export const isFindableStatuteColumn = (column: StatuteColumnId): boolean =>
  STATUTE_FIND_TEXT[column] !== null;

/** What one statute row shows, per column id, for the columns a find reaches. */
export const statuteFindRowText = (
  statute: StatuteListItem,
): ReadonlyMap<string, string> => {
  const text = new Map<string, string>();
  for (const column of STATUTE_COLUMN_IDS) {
    const read = STATUTE_FIND_TEXT[column];
    if (read !== null) {
      text.set(column, read(statute));
    }
  }
  return text;
};
