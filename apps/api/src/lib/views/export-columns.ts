import type { PropertyTool } from "@/api/db/schema-validators";
import { viewIncludesListItems } from "@/api/lib/views";
import type { ViewLayout } from "@/api/lib/views-schema";

const METADATA_COLUMNS = [
  { id: "_created-by", header: "Author" },
  { id: "_updated-at", header: "Last updated" },
  { id: "_version", header: "Version" },
] as const;

const LIST_COLUMNS = [
  { id: "_name", header: "Name" },
  { id: "_list-item-type", header: "Type" },
  { id: "_status", header: "Status" },
  { id: "_priority", header: "Priority" },
  { id: "_due-date", header: "Due date" },
] as const;

type ExportProperty = {
  id: string;
  name: string;
  tool: PropertyTool;
};

export type ExportColumn =
  | {
      type: "property";
      id: string;
      propertyId: string;
      header: string;
      // A graded playbook position renders its ASK column merged with the
      // tier from this paired `playbook-verdict` property; the verdict never
      // gets its own column.
      verdictPropertyId?: string;
      // The property whose field justification annotates this cell as a note:
      // the verdict for a merged position, otherwise the AI extraction itself.
      commentPropertyId?: string;
    }
  | {
      type: "metadata";
      id: (typeof METADATA_COLUMNS)[number]["id"];
      header: string;
    }
  | {
      type: "list";
      id: (typeof LIST_COLUMNS)[number]["id"];
      header: string;
    };

export const buildExportColumns = (
  layout: Extract<ViewLayout, { type: "table" }>,
  properties: ExportProperty[],
): ExportColumn[] => {
  const hiddenIds = new Set(layout.hiddenProperties);
  const verdictByAskPropertyId = new Map<string, ExportProperty>();
  const verdictPropertyIds = new Set<string>();
  for (const property of properties) {
    if (property.tool.type === "playbook-verdict") {
      verdictByAskPropertyId.set(property.tool.askPropertyId, property);
      verdictPropertyIds.add(property.id);
    }
  }

  const propertyColumns: Extract<ExportColumn, { type: "property" }>[] = [];
  for (const property of properties) {
    if (hiddenIds.has(property.id) || verdictPropertyIds.has(property.id)) {
      continue;
    }
    const column: Extract<ExportColumn, { type: "property" }> = {
      type: "property",
      id: property.id,
      propertyId: property.id,
      header: property.name,
    };

    const verdict = verdictByAskPropertyId.get(property.id);
    if (verdict) {
      column.verdictPropertyId = verdict.id;
      column.commentPropertyId = verdict.id;
    } else if (property.tool.type === "ai-model") {
      column.commentPropertyId = property.id;
    }

    propertyColumns.push(column);
  }
  const metadataColumns = METADATA_COLUMNS.flatMap((column) =>
    hiddenIds.has(column.id)
      ? []
      : [{ type: "metadata" as const, id: column.id, header: column.header }],
  );
  const listColumns = viewIncludesListItems(layout.filters)
    ? LIST_COLUMNS.flatMap((column) =>
        hiddenIds.has(column.id)
          ? []
          : [{ type: "list" as const, id: column.id, header: column.header }],
      )
    : [];
  const defaultColumns: ExportColumn[] = [
    ...listColumns,
    ...propertyColumns,
    ...metadataColumns,
  ];

  if (layout.columnOrder.length === 0) {
    return defaultColumns;
  }

  const byId = new Map(defaultColumns.map((column) => [column.id, column]));
  const ordered: ExportColumn[] = [];
  for (const columnId of layout.columnOrder) {
    const column = byId.get(columnId);
    if (!column) {
      continue;
    }
    ordered.push(column);
    byId.delete(columnId);
  }

  return [...ordered, ...byId.values()];
};
