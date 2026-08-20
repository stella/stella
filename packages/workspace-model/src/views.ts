import type { CalculationKind } from "@stll/calculations";
import type { ConditionNode } from "@stll/conditions";

import type { WorkspaceIdentifier } from "./properties";

export const workspaceViewLayoutTypes = [
  "table",
  "kanban",
  "calendar",
  "timeline",
] as const;

export type WorkspaceViewLayoutType = (typeof workspaceViewLayoutTypes)[number];

export const workspaceCalendarModes = ["month", "week", "year"] as const;
export type WorkspaceCalendarMode = (typeof workspaceCalendarModes)[number];

export const workspaceTimelineZoomLevels = [
  "day",
  "week",
  "month",
  "quarter",
] as const;
export type WorkspaceTimelineZoomLevel =
  (typeof workspaceTimelineZoomLevels)[number];

export const workspaceTimelineTableModes = ["hidden", "visible"] as const;
export type WorkspaceTimelineTableMode =
  (typeof workspaceTimelineTableModes)[number];

export type WorkspaceViewSort = {
  desc: boolean;
  propertyId: string;
};

export type WorkspaceViewCalculation = {
  kind: CalculationKind;
  propertyId: string;
};

export type WorkspaceViewLayoutBase = {
  calculations: readonly WorkspaceViewCalculation[];
  filters: readonly ConditionNode[];
  hiddenProperties: readonly string[];
  sorts: readonly WorkspaceViewSort[];
  version: 1;
};

export type WorkspaceTableViewLayout = WorkspaceViewLayoutBase & {
  columnOrder: readonly string[];
  columnPinning: readonly string[];
  groupByPropertyId?: string | undefined;
  type: "table";
};

export type WorkspaceKanbanViewLayout = WorkspaceViewLayoutBase & {
  groupByPropertyId?: string | undefined;
  type: "kanban";
};

export type WorkspaceCalendarViewLayout = WorkspaceViewLayoutBase & {
  additionalDatePropertyIds?: readonly string[] | undefined;
  datePropertyId: string;
  endDatePropertyId?: string | undefined;
  mode: WorkspaceCalendarMode;
  type: "calendar";
};

export type WorkspaceTimelineViewLayout = WorkspaceViewLayoutBase & {
  endDatePropertyId: string;
  groupByPropertyId?: string | undefined;
  startDatePropertyId: string;
  tableMode: WorkspaceTimelineTableMode;
  type: "timeline";
  zoom: WorkspaceTimelineZoomLevel;
};

/**
 * Presentation over one canonical entity collection. Layout arms own only
 * display and query configuration; entity values never belong to a view.
 */
export type WorkspaceViewLayout =
  | WorkspaceTableViewLayout
  | WorkspaceKanbanViewLayout
  | WorkspaceCalendarViewLayout
  | WorkspaceTimelineViewLayout;

export type WorkspaceSavedView<
  ViewId extends WorkspaceIdentifier = WorkspaceIdentifier,
  Layout extends WorkspaceViewLayout = WorkspaceViewLayout,
> = {
  createdAt: string;
  id: ViewId;
  layout: Layout;
  name: string;
  position: number;
  version: 1;
};

const workspaceViewLayoutTypeSet: ReadonlySet<string> = new Set(
  workspaceViewLayoutTypes,
);

export const isWorkspaceViewLayoutType = (
  value: string,
): value is WorkspaceViewLayoutType => workspaceViewLayoutTypeSet.has(value);
