import type { WorkspacesData } from "@/lib/workspaces/queries";

export type Workspace = WorkspacesData["workspaces"][number];

export const MATTERS_SORT_KEYS = [
  "name",
  "reference",
  "entityCount",
  "lastActivityAt",
  "createdAt",
  "clientName",
] as const;

export type MattersSortKey = (typeof MATTERS_SORT_KEYS)[number];

export const ALL_COLUMNS = [
  "client",
  "team",
  "reference",
  "entityCount",
  "lastActivityAt",
  "createdAt",
] as const;

export type MattersColumnId = (typeof ALL_COLUMNS)[number];

export const PERSONAL_GROUP_ID = "personal";

export type WorkspaceGroup =
  | {
      type: "client";
      groupId: string;
      clientId: string;
      clientName: string;
      responsibleAttorneyName: string | null;
      workspaces: Workspace[];
    }
  | {
      type: "personal";
      groupId: typeof PERSONAL_GROUP_ID;
      workspaces: Workspace[];
    };

export const DATE_FILTER_PRESETS = [
  "today",
  "thisWeek",
  "last7d",
  "last30d",
  "thisMonth",
  "custom",
] as const;

export type DateFilterPreset = (typeof DATE_FILTER_PRESETS)[number];

/** Custom uses `from`/`to` (ISO `YYYY-MM-DD`); presets ignore them. */
export type DateFilter = {
  preset: DateFilterPreset;
  from?: string;
  to?: string;
};

/** `any` = matter has a lead; `none` = no lead; `user` = specific lead. */
export type LeadFilter =
  | { type: "any" }
  | { type: "none" }
  | { type: "user"; userId: string };

export type NumericFilter = {
  gte?: number;
  lte?: number;
};

export type MattersFilters = {
  lastActivityAt?: DateFilter;
  createdAt?: DateFilter;
  client?: string[];
  team?: string[];
  lead?: LeadFilter;
  entityCount?: NumericFilter;
};

/** Column ids that support a filter popover off their header.
 *  The Team header's popover also drives the Lead filter, since the
 *  lead is rendered inside the Team avatar stack. */
const MATTERS_COLUMN_FILTERABILITY = {
  client: "filterable",
  team: "filterable",
  reference: "not-filterable",
  entityCount: "filterable",
  lastActivityAt: "filterable",
  createdAt: "filterable",
} as const satisfies Record<MattersColumnId, "filterable" | "not-filterable">;

export type FilterableColumnId = {
  [TColumnId in MattersColumnId]: (typeof MATTERS_COLUMN_FILTERABILITY)[TColumnId] extends "filterable"
    ? TColumnId
    : never;
}[MattersColumnId];

export const FILTERABLE_COLUMN_IDS = ALL_COLUMNS.filter(
  (columnId): columnId is FilterableColumnId =>
    MATTERS_COLUMN_FILTERABILITY[columnId] === "filterable",
);

export const isFilterableColumnId = (id: string): id is FilterableColumnId =>
  FILTERABLE_COLUMN_IDS.some((columnId) => columnId === id);
