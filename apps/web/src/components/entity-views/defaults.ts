import type { WorkspaceView } from "@/lib/types";

import { ENTITY_VIEW_GROUP } from "./model";

export const defaultEntityViews = (labels: {
  table: string;
  kanban: string;
}) => {
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
    sorts: [],
    hiddenProperties: [],
    calculations: [],
  };
  return [
    {
      version: 1,
      id: "default:kanban",
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
  ] satisfies WorkspaceView[];
};
