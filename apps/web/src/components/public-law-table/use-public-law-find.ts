/**
 * Find-in-table over a public-law results page.
 *
 * The workspace table's bar, resolution and marks; what this adds is where the
 * find is kept. It is kept in page state rather than stored: a find is a
 * question about the rows in front of the reader, and a public page has no
 * account to hang one on anyway. Which columns a find can reach, and the text
 * each shows, is the calling table's.
 */

import { useState } from "react";
import type { ComponentProps, RefObject } from "react";

import type { TableFindHighlight } from "@/components/workspaces/table/find-highlight";
import type {
  TableFindBar,
  TableFindColumnRow,
} from "@/components/workspaces/table/table-find-bar";
import {
  findTableRows,
  resolveTableFind,
  UNRESTRICTED_FIND,
} from "@/components/workspaces/table/table-find.logic";
import type {
  TableFindPersistence,
  TableFindRowText,
  TableFindState,
} from "@/components/workspaces/table/table-find.logic";

type UsePublicLawFindOptions<TRow> = {
  /**
   * The columns on screen, in the picker's order. A column the reader hid is
   * left out: a row that matched only where the reader cannot see would show
   * no mark and read as a bug.
   */
  columns: readonly TableFindColumnRow[];
  /** The pane a Cmd/Ctrl+F inside belongs to. */
  paneRef: RefObject<HTMLElement | null>;
  rows: readonly TRow[];
  /** What one row shows, per column id, for the columns a find reaches. */
  rowText: (row: TRow) => TableFindRowText;
  /** What the find belongs to: a jurisdiction, or a matter's mixed list. */
  surfaceKey: string;
};

export type PublicLawFind<TRow> = {
  /** Everything the shared bar is drawn from. */
  bar: ComponentProps<typeof TableFindBar>;
  highlight: TableFindHighlight | null;
  /** The rows the find leaves on screen. */
  rows: readonly TRow[];
};

export const usePublicLawFind = <TRow>({
  columns,
  paneRef,
  rows,
  rowText,
  surfaceKey,
}: UsePublicLawFindOptions<TRow>): PublicLawFind<TRow> => {
  const [state, setState] = useState<TableFindState | undefined>(undefined);
  // A find belongs to the list it was typed over. Switching jurisdictions
  // gives a different corpus, so the term does not follow; adjusting during
  // render is the sanctioned reset, and the bar reads the new state.
  const [findFor, setFindFor] = useState(surfaceKey);
  if (findFor !== surfaceKey) {
    setFindFor(surfaceKey);
    setState(undefined);
  }

  const resolved = resolveTableFind({
    columns,
    // A public-law row has no name column: every string it shows belongs to a
    // column of its own.
    hasNameColumn: false,
    selection: state?.scope ?? UNRESTRICTED_FIND,
    term: state?.submitted ?? "",
  });

  const find: TableFindPersistence = {
    clear: () => {
      setState(undefined);
    },
    close: () => {
      setState((current) =>
        current === undefined ? current : { ...current, status: "closed" },
      );
    },
    key: surfaceKey,
    open: () => {
      setState((current) =>
        current === undefined ? OPENED_FIND : { ...current, status: "open" },
      );
    },
    setScope: (scope) => {
      setState((current) =>
        current === undefined ? current : { ...current, scope },
      );
    },
    setTyped: (typed) => {
      setState((current) =>
        current === undefined ? current : { ...current, typed },
      );
    },
    state,
    submit: () => {
      setState((current) =>
        current === undefined
          ? current
          : { ...current, submitted: current.typed },
      );
    },
  };

  return {
    bar: {
      appliedTerm: resolved.term,
      columns,
      find,
      paneRef,
      selection: resolved.selection,
    },
    highlight: resolved.highlight,
    rows: findTableRows({
      columnIds: resolved.columnIds,
      rows,
      rowText,
      term: resolved.term,
    }),
  };
};

/** A find that has only just been opened: the bar is up, nothing is typed. */
const OPENED_FIND: TableFindState = {
  scope: UNRESTRICTED_FIND,
  status: "open",
  submitted: "",
  typed: "",
};
