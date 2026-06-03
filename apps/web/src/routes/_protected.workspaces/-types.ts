import type { WorkspacesData } from "@/routes/_protected.workspaces/-queries";

export type Workspace = WorkspacesData["workspaces"][number];

export type MattersSortKey =
  | "name"
  | "reference"
  | "entityCount"
  | "lastActivityAt"
  | "createdAt"
  | "clientName";

export type MattersColumnId =
  | "client"
  | "reference"
  | "entityCount"
  | "lastActivityAt"
  | "createdAt"
  | "team";

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

export const ALL_COLUMNS = [
  "client",
  "team",
  "reference",
  "entityCount",
  "lastActivityAt",
  "createdAt",
] as const satisfies readonly MattersColumnId[];

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
export const FILTERABLE_COLUMN_IDS = [
  "client",
  "team",
  "entityCount",
  "lastActivityAt",
  "createdAt",
] as const satisfies readonly MattersColumnId[];

export type FilterableColumnId = (typeof FILTERABLE_COLUMN_IDS)[number];

export const isFilterableColumnId = (id: string): id is FilterableColumnId =>
  (FILTERABLE_COLUMN_IDS as readonly string[]).includes(id);
