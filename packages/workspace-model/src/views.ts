import type { CalculationKind } from "@stll/calculations";
import type {
  CompareNode,
  ConditionNode,
  GroupNode,
  Operand,
  PredicateNode,
} from "@stll/conditions";

import type {
  WorkspaceIdentifier,
  WorkspacePropertyIdentifier,
} from "./properties";

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

type WorkspaceViewOperand<PropertyId extends WorkspacePropertyIdentifier> =
  | Exclude<Operand, { type: "property" }>
  | { propertyId: PropertyId; type: "property" };

export type WorkspaceViewConditionNode<
  PropertyId extends WorkspacePropertyIdentifier = WorkspacePropertyIdentifier,
> =
  | (Omit<CompareNode, "left" | "right"> & {
      left: WorkspaceViewOperand<PropertyId>;
      right: WorkspaceViewOperand<PropertyId>;
    })
  | (Omit<PredicateNode, "operand"> & {
      operand: WorkspaceViewOperand<PropertyId>;
    })
  | (Omit<GroupNode, "children"> & {
      children: WorkspaceViewConditionNode<PropertyId>[];
    });

true satisfies Exclude<
  ConditionNode["type"],
  WorkspaceViewConditionNode["type"]
> extends never
  ? true
  : never;

export type WorkspaceViewSort<
  PropertyId extends WorkspacePropertyIdentifier = WorkspacePropertyIdentifier,
> = {
  desc: boolean;
  propertyId: PropertyId;
};

export type WorkspaceViewCalculation<
  PropertyId extends WorkspacePropertyIdentifier = WorkspacePropertyIdentifier,
> = {
  kind: CalculationKind;
  propertyId: PropertyId;
};

export type WorkspaceViewLayoutBase<
  PropertyId extends WorkspacePropertyIdentifier = WorkspacePropertyIdentifier,
> = {
  calculations: readonly WorkspaceViewCalculation<PropertyId>[];
  filters: readonly WorkspaceViewConditionNode<PropertyId>[];
  hiddenProperties: readonly PropertyId[];
  sorts: readonly WorkspaceViewSort<PropertyId>[];
  version: 1;
};

export type WorkspaceTableViewLayout<
  PropertyId extends WorkspacePropertyIdentifier = WorkspacePropertyIdentifier,
> = WorkspaceViewLayoutBase<PropertyId> & {
  columnOrder: readonly PropertyId[];
  columnPinning: readonly PropertyId[];
  groupByPropertyId?: PropertyId | undefined;
  type: "table";
};

export type WorkspaceKanbanViewLayout<
  PropertyId extends WorkspacePropertyIdentifier = WorkspacePropertyIdentifier,
> = WorkspaceViewLayoutBase<PropertyId> & {
  groupByPropertyId?: PropertyId | undefined;
  subgroupByPropertyId?: PropertyId | undefined;
  type: "kanban";
};

export type WorkspaceCalendarViewLayout<
  PropertyId extends WorkspacePropertyIdentifier = WorkspacePropertyIdentifier,
> = WorkspaceViewLayoutBase<PropertyId> & {
  additionalDatePropertyIds?: readonly PropertyId[] | undefined;
  datePropertyId: PropertyId;
  endDatePropertyId?: PropertyId | undefined;
  mode: WorkspaceCalendarMode;
  type: "calendar";
};

export type WorkspaceTimelineViewLayout<
  PropertyId extends WorkspacePropertyIdentifier = WorkspacePropertyIdentifier,
> = WorkspaceViewLayoutBase<PropertyId> & {
  endDatePropertyId: PropertyId;
  groupByPropertyId?: PropertyId | undefined;
  showTable: boolean;
  startDatePropertyId: PropertyId;
  type: "timeline";
  zoom: WorkspaceTimelineZoomLevel;
};

/**
 * Presentation over one canonical entity collection. Layout arms own only
 * display and query configuration; entity values never belong to a view.
 */
export type WorkspaceViewLayout<
  PropertyId extends WorkspacePropertyIdentifier = WorkspacePropertyIdentifier,
> =
  | WorkspaceTableViewLayout<PropertyId>
  | WorkspaceKanbanViewLayout<PropertyId>
  | WorkspaceCalendarViewLayout<PropertyId>
  | WorkspaceTimelineViewLayout<PropertyId>;

export type WorkspaceSavedView<
  ViewId extends WorkspaceIdentifier = WorkspaceIdentifier,
  PropertyId extends WorkspacePropertyIdentifier = WorkspacePropertyIdentifier,
  Layout extends WorkspaceViewLayout<PropertyId> =
    WorkspaceViewLayout<PropertyId>,
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
