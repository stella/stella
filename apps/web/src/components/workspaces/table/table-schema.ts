/**
 * What a workspace table's columns are, whatever its rows are.
 *
 * The column-render union spans both row kinds and is split by the kind whose
 * rows a member can read, so a table over entity rows cannot be handed a
 * column that draws a decision. The two utility columns are here because every
 * table has them; each kind's own columns are declared by its own half.
 *
 * Public-safe: this module reaches into no route, so the public results page
 * builds its columns from the same descriptors a matter's table does.
 */

import type { TableColumnDescriptor, TableSchema } from "@stll/ui/data-table";

import type {
  DecisionColumnRender,
  DecisionExtraColumnRender,
} from "@/features/case-law/decision-columns.logic";
import type { QuestionColumnRender } from "@/features/case-law/research/question-columns.logic";
import type { WorkspaceProperty } from "@/lib/types";

export const DEFAULT_TABLE_COLUMN_MIN_SIZE = 64;

export const SELECT_COLUMN_SIZE = 48;
export const ADD_PROPERTY_COLUMN_SIZE = 48;
export const PROPERTY_COLUMN_SIZE = 200;

/** The columns a table has whatever its rows are. */
type UtilityColumnRender = { type: "select" } | { type: "add-property" };

/** What draws a column's header and cells over entity rows. */
export type WorkspaceEntityColumnRender =
  | UtilityColumnRender
  | { type: "name" }
  | { type: "list-item-type" }
  | { type: "task-status" }
  | { type: "task-priority" }
  | { type: "task-due-date" }
  | { type: "created-by" }
  | { type: "updated-at" }
  | { type: "version" }
  | {
      type: "property";
      property: WorkspaceProperty;
      /** The GRADE column paired with this ASK column, when there is one. */
      verdictProperty: WorkspaceProperty | undefined;
    };

/**
 * What draws a column's header and cells over decision rows. The decision
 * member is the case-law feature's, so the public results page can build and
 * draw its columns without reaching into a matter's route.
 */
export type WorkspaceDecisionColumnRender =
  | UtilityColumnRender
  | DecisionColumnRender
  | DecisionExtraColumnRender
  | QuestionColumnRender;

/**
 * What draws a column's header and cells.
 *
 * One union across row kinds, split by the kind whose rows a member can read:
 * a member is drawn from a row, and TanStack's column definition takes that
 * row as a parameter, so a table over entity rows cannot be handed a column
 * that reads a decision. A new member joins one of the two halves, and that
 * half's factory stops compiling until it draws it.
 */
export type WorkspaceColumnRender =
  | WorkspaceEntityColumnRender
  | WorkspaceDecisionColumnRender;

export type WorkspaceTableSchema<
  TRender extends WorkspaceColumnRender = WorkspaceEntityColumnRender,
> = TableSchema<TRender>;
export type WorkspaceColumnDescriptor<
  TRender extends WorkspaceColumnRender = WorkspaceEntityColumnRender,
> = TableColumnDescriptor<TRender>;

type UtilityColumnParams<TRender extends WorkspaceColumnRender> = {
  id: string;
  size: number;
  render: TRender;
  /** The select column is pinned to the start of every table. */
  pin: boolean;
};

export const utilityColumn = <TRender extends WorkspaceColumnRender>({
  id,
  size,
  render,
  pin,
}: UtilityColumnParams<TRender>): WorkspaceColumnDescriptor<TRender> => ({
  id,
  label: "",
  render,
  size,
  minSize: size,
  capabilities: { sort: false, hide: false, resize: false, pin },
  emphasis: "utility",
});
