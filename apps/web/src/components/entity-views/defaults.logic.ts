import type { ViewLayoutType } from "@stll/api-contract";
import {
  type ENTITY_VIEW_COLUMNS,
  ENTITY_VIEW_GROUP,
} from "@stll/api-contract/entity-views";

import type { PendingTextKey } from "@/components/pending-text";
import type { ViewLayout, WorkspaceView } from "@/lib/types";
import type { InboxLastLayout } from "@/stores/config-store";

/** The inbox's layouts, by the words each default view is named with. */
export const DEFAULT_ENTITY_VIEW_LABEL_KEYS = {
  kanban: "workspaces.views.layouts.kanban",
  table: "workspaces.views.layouts.table",
} as const satisfies Record<
  Extract<ViewLayoutType, "kanban" | "table">,
  PendingTextKey
>;

/**
 * The groupings the inbox offers beside the workspace's own (status, kind,
 * assignee, author), in the menus' order, with the words each reads as.
 */
export const ENTITY_VIEW_EXTRA_GROUPS = [
  { id: ENTITY_VIEW_GROUP.TYPE, labelKey: "common.type" },
  { id: ENTITY_VIEW_GROUP.MATTER, labelKey: "common.matter" },
] as const;

/** The view the inbox opens on before a member picks one. */
export const DEFAULT_ENTITY_VIEW_ID = "default:kanban";

/** A view no member saved yet: one of the defaults, or a new one in flight. */
export const isUnsavedViewId = (id: string) =>
  id.startsWith("default:") || id.startsWith("draft:");

export const defaultEntityViews = (labels: {
  table: string;
  kanban: string;
}): WorkspaceView[] => {
  const base = {
    version: 1 as const,
    filters: [
      {
        type: "predicate" as const,
        operand: { type: "kind" as const },
        op: "in" as const,
        value: ["task"],
      },
    ],
    // Soonest due first: overdue work leads, undated rows trail.
    sorts: [
      {
        propertyId: "_due-date" satisfies keyof typeof ENTITY_VIEW_COLUMNS,
        desc: false,
      },
    ],
    hiddenProperties: [],
    calculations: [],
  };
  return [
    {
      version: 1,
      id: DEFAULT_ENTITY_VIEW_ID,
      name: labels.kanban,
      position: 0,
      createdAt: "",
      layout: {
        ...base,
        type: "kanban",
        groupByPropertyId: ENTITY_VIEW_GROUP.STATUS,
        subgroupByPropertyId: ENTITY_VIEW_GROUP.TYPE,
      },
    },
    {
      version: 1,
      id: "default:table",
      name: labels.table,
      position: 1,
      createdAt: "",
      layout: { ...base, type: "table", columnOrder: [], columnPinning: [] },
    },
  ];
};

/**
 * The views the inbox's strip shows: the member's saved views, then a default
 * of each layout none of them has.
 */
export const entityViewsWithDefaults = (
  saved: readonly WorkspaceView[],
  defaults: readonly WorkspaceView[],
): WorkspaceView[] => [
  ...saved,
  ...defaults.filter(
    (view) =>
      !saved.some((savedView) => savedView.layout.type === view.layout.type),
  ),
];

/**
 * What of a view's layout the inbox's loading body is drawn from, to keep
 * for the next cold load; `null` for a layout the inbox does not draw.
 */
export const entityViewLastLayout = (
  layout: ViewLayout,
): InboxLastLayout | null => {
  if (layout.type === "kanban") {
    return {
      type: "kanban",
      groupByPropertyId: layout.groupByPropertyId ?? null,
      subgroupByPropertyId: layout.subgroupByPropertyId ?? null,
    };
  }
  if (layout.type === "table") {
    return {
      type: "table",
      groupByPropertyId: layout.groupByPropertyId ?? null,
      hiddenProperties: [...layout.hiddenProperties],
      columnOrder: [...layout.columnOrder],
      columnPinning: [...layout.columnPinning],
    };
  }
  return null;
};

/**
 * The view the inbox shows: the chosen one (or its draft), else the first,
 * which is where the inbox opens when the default it starts on was replaced
 * by a saved view.
 */
export const selectEntityView = (
  views: readonly WorkspaceView[],
  selectedId: string,
): WorkspaceView | undefined =>
  views.find((view) => view.id === selectedId) ?? views.at(0);
