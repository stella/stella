/**
 * The workspace table's instance of the kit's table schema.
 *
 * Which columns a table view has, in order, and what each of them can do. What
 * a header or a cell draws lives in `table-columns.tsx`; this module carries
 * only the description, which is what makes the column set testable without
 * rendering a table.
 */

import type { TableColumnDescriptor, TableSchema } from "@stll/ui/data-table";

import {
  getInternalColId,
  getInternalPropertyId,
} from "@/components/workspaces/entity-utils";
import type { DecisionColumnRender } from "@/features/case-law/decision-columns.logic";
import type { WorkspaceProperty, WorkspaceView } from "@/lib/types";
import { pairPlaybookVerdicts } from "@/lib/workspaces/playbook-verdicts";
import { includesListItems } from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-kind-filters";

export const DEFAULT_TABLE_COLUMN_MIN_SIZE = 64;

const SELECT_COLUMN_SIZE = 48;
const ADD_PROPERTY_COLUMN_SIZE = 48;
const PROPERTY_COLUMN_SIZE = 200;

/** The columns a table has whatever its rows are. */
type UtilityColumnRender = { type: "select" } | { type: "add-property" };

/** What draws a column's header and cells over entity rows. */
type WorkspaceEntityColumnRender =
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
type WorkspaceDecisionColumnRender = UtilityColumnRender | DecisionColumnRender;

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

/** Labels the schema needs; the caller resolves them for the reader's locale. */
export type WorkspaceTableLabels = {
  name: string;
  itemType: string;
  status: string;
  priority: string;
  dueDate: string;
  author: string;
  lastUpdated: string;
  version: string;
};

export type WorkspaceTableSchemaParams = {
  properties: readonly WorkspaceProperty[];
  view: WorkspaceView<"table">;
  labels: WorkspaceTableLabels;
};

type UtilityColumnParams<TRender extends WorkspaceColumnRender> = {
  id: string;
  size: number;
  render: TRender;
  /** The select column is pinned to the start of every table. */
  pin: boolean;
};

const utilityColumn = <TRender extends WorkspaceColumnRender>({
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

const listColumn = (
  id: string,
  label: string,
  size: number,
  render: WorkspaceEntityColumnRender,
  { sort = true }: { sort?: boolean } = {},
): WorkspaceColumnDescriptor => ({
  id,
  label,
  render,
  size,
  capabilities: { sort, hide: true, resize: true, pin: true },
  emphasis: "content",
});

const metadataColumn = (
  id: string,
  label: string,
  size: number,
  render: WorkspaceEntityColumnRender,
): WorkspaceColumnDescriptor => ({
  id,
  label,
  render,
  size,
  capabilities: { sort: true, hide: true, resize: true, pin: true },
  emphasis: "metadata",
});

export const workspaceTableSchema = ({
  properties,
  view,
  labels,
}: WorkspaceTableSchemaParams): WorkspaceTableSchema => {
  const columns: WorkspaceColumnDescriptor[] = [
    utilityColumn({
      id: getInternalColId("select"),
      size: SELECT_COLUMN_SIZE,
      render: { type: "select" },
      pin: true,
    }),
  ];

  if (includesListItems(view.layout.filters)) {
    columns.push(
      listColumn(getInternalPropertyId("name"), labels.name, 260, {
        type: "name",
      }),
      listColumn(
        getInternalPropertyId("list-item-type"),
        labels.itemType,
        140,
        { type: "list-item-type" },
        { sort: false },
      ),
      listColumn(getInternalPropertyId("status"), labels.status, 140, {
        type: "task-status",
      }),
      listColumn(getInternalPropertyId("priority"), labels.priority, 120, {
        type: "task-priority",
      }),
      listColumn(getInternalPropertyId("due-date"), labels.dueDate, 140, {
        type: "task-due-date",
      }),
    );
  }

  // Each ASK column renders one compliance-matrix cell; the pairing (and the
  // rule that a verdict never gets a column of its own) lives in
  // `pairPlaybookVerdicts`, so every surface listing properties inherits it.
  for (const { property, verdictProperty } of pairPlaybookVerdicts([
    ...properties,
  ])) {
    columns.push({
      id: property.id,
      label: property.name,
      render: { type: "property", property, verdictProperty },
      size: PROPERTY_COLUMN_SIZE,
      capabilities: { sort: true, hide: true, resize: true, pin: true },
      emphasis: "content",
    });
  }

  columns.push(
    metadataColumn(getInternalPropertyId("created-by"), labels.author, 160, {
      type: "created-by",
    }),
    metadataColumn(
      getInternalPropertyId("updated-at"),
      labels.lastUpdated,
      140,
      { type: "updated-at" },
    ),
    metadataColumn(getInternalPropertyId("version"), labels.version, 80, {
      type: "version",
    }),
    utilityColumn({
      id: getInternalColId("add-property"),
      size: ADD_PROPERTY_COLUMN_SIZE,
      render: { type: "add-property" },
      pin: false,
    }),
  );

  return { columns, defaultMinSize: DEFAULT_TABLE_COLUMN_MIN_SIZE };
};
