import type { CSSProperties } from "react";
import type { Column, Row, SortingFn } from "@tanstack/react-table";

import { useI18nStore } from "@/i18n/i18n-store";
import type {
  ViewFilterCondition,
  WorkspaceEntity,
  WorkspaceField,
  WorkspaceProperty,
} from "@/lib/types";

type InternalColId = "select" | "add-property";

const internalColMap: Record<InternalColId, null> = {
  select: null,
  "add-property": null,
};

export const getInternalColId = (col: InternalColId): InternalColId => col;

export const isInternalColId = (id: string): id is InternalColId => {
  return Object.keys(internalColMap).includes(id);
};

export const getPinningStyles = <T = WorkspaceEntity>(
  column: Column<T>,
): CSSProperties => {
  const canPin = column.getCanPin();

  // last non pinnable column always needs to stretch
  if (!canPin && column.getIsLastColumn()) {
    return {
      width: "auto",
    };
  }

  if (!canPin) {
    return {};
  }

  const isPinned = column.getIsPinned() === "left";
  const isLastPinnedColumn =
    column.id !== getInternalColId("select") &&
    isPinned &&
    column.getIsLastColumn("left");

  return {
    backgroundColor: isPinned ? "var(--color-background)" : undefined,
    boxShadow: isLastPinnedColumn
      ? "-2px 0 0px 0px var(--color-border) inset"
      : undefined,
    left: isPinned ? `${column.getStart("left")}px` : undefined,
    position: isPinned ? "sticky" : undefined,
    width: column.getSize(),
    zIndex: isPinned ? 2 : undefined,
  };
};

export const validateFieldForComputation = (
  field: WorkspaceField | undefined,
) => {
  if (!field) {
    return true;
  }

  if (field.content.type === "pending") {
    return false;
  }

  if (field.content.type === "file") {
    return true;
  }

  if (field.content.type === "error") {
    return true;
  }

  if (field.content.type === "unsupported") {
    return true;
  }

  if (field.content.type === "multi-select") {
    return (
      field.content.value?.every((value) => value.trim().length <= 0) ?? false
    );
  }

  if (field.content.type === "date") {
    return !field.content.value || field.content.value.trim().length <= 0;
  }

  if (field.content.type === "int") {
    return false;
  }

  if (field.content.value === null) {
    return false;
  }

  return field.content.value.trim().length <= 0;
};

declare module "@tanstack/table-core" {
  // biome-ignore lint/style/useConsistentTypeDefinitions: Tanstack Table
  interface SortingFns {
    sortProperty: SortingFn<WorkspaceEntity>;
  }
}

type SortRow = Pick<Row<WorkspaceEntity>, "original">;

export const sortProperty = (
  rowA: SortRow,
  rowB: SortRow,
  columnId: string,
): number => {
  const fieldA = rowA.original.fields[columnId];
  const fieldB = rowB.original.fields[columnId];

  // Entities without the sorted field sort to the end
  if (!fieldA && !fieldB) {
    return 0;
  }
  if (!fieldA) {
    return 1;
  }
  if (!fieldB) {
    return -1;
  }

  let valueA: string | null = null;
  let valueB: string | null = null;

  if (fieldA.content.type === "file" && fieldB.content.type === "file") {
    valueA = fieldA.content.fileName;
    valueB = fieldB.content.fileName;
  }

  if (fieldA.content.type === "text" && fieldB.content.type === "text") {
    valueA = fieldA.content.value;
    valueB = fieldB.content.value;
  }

  if (
    fieldA.content.type === "single-select" &&
    fieldB.content.type === "single-select"
  ) {
    valueA = fieldA.content.value;
    valueB = fieldB.content.value;
  }

  if (
    fieldA.content.type === "multi-select" &&
    fieldB.content.type === "multi-select"
  ) {
    valueA = fieldA.content.value.toSorted().join(", ");
    valueB = fieldB.content.value.toSorted().join(", ");
  }

  if (fieldA.content.type === "date" && fieldB.content.type === "date") {
    valueA = fieldA.content.value;
    valueB = fieldB.content.value;
  }

  if (fieldA.content.type === "int" && fieldB.content.type === "int") {
    return fieldA.content.value - fieldB.content.value;
  }

  if (valueA === null && valueB === null) {
    return 0;
  }

  return valueA?.localeCompare(valueB ?? "") ?? 0;
};

export const getFieldValue = (field: WorkspaceField | undefined) => {
  if (!field) {
    return "";
  }

  switch (field.content.type) {
    case "text":
      return field.content.value;
    case "file":
      return field.content.fileName;
    case "single-select":
      return field.content.value;
    case "multi-select":
      return field.content.value.join(", ");
    case "date":
      return field.content.value
        ? new Date(field.content.value).toLocaleDateString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
            timeZone: "UTC",
          })
        : "";
    case "int":
      return field.content.currency
        ? `${field.content.value} ${field.content.currency}`
        : String(field.content.value);
    default:
      return "";
  }
};

export const getEntityName = (entity: WorkspaceEntity): string => {
  // Entity-level name takes priority (used by folders)
  if (entity.name) {
    return entity.name;
  }

  const fields = Object.values(entity.fields);
  const fileField = fields.find((f) => f.content.type === "file");

  if (fileField?.content.type === "file" && fileField.content.fileName) {
    return fileField.content.fileName;
  }

  const textField = fields.find((f) => f.content.type === "text");

  if (textField?.content.type === "text" && textField.content.value.trim()) {
    return textField.content.value;
  }

  return entity.kind === "folder" ? "Untitled Folder" : "Untitled";
};

export const getEntityTypeLabel = (entity: WorkspaceEntity): string => {
  if (entity.kind === "folder") {
    return "Folder";
  }

  const fileField = Object.values(entity.fields).find(
    (f) => f.content.type === "file",
  );

  if (fileField?.content.type === "file") {
    const parts = fileField.content.fileName.split(".");
    if (parts.length > 1) {
      const ext = parts.at(-1);
      if (ext) {
        return `.${ext}`;
      }
    }

    const mimeExt = fileField.content.mimeType.split("/").pop();
    if (mimeExt) {
      return mimeExt.toUpperCase();
    }
  }

  return entity.kind.charAt(0).toUpperCase() + entity.kind.slice(1);
};

export const getFirstFile = (entity: WorkspaceEntity) => {
  for (const [propertyId, field] of Object.entries(entity.fields)) {
    if (field.content.type === "file") {
      return {
        fieldId: field.id,
        propertyId,
        entityId: field.entityId,
        fileName: field.content.fileName,
        mimeType: field.content.mimeType,
        encrypted: field.content.encrypted,
        pdfFileId: field.content.pdfFileId,
      };
    }
  }

  return null;
};

const matchesFilter = (
  entity: WorkspaceEntity,
  filter: ViewFilterCondition,
): boolean => {
  if (filter.field === "kind") {
    // Kind filtering requires entity hierarchy (not yet available).
    // Pass through all entities for now.
    return true;
  }

  const fieldValue = getFieldValue(entity.fields[filter.propertyId]);

  const normalizedValue = fieldValue ?? "";

  switch (filter.op) {
    case "eq":
      return normalizedValue === (filter.value ?? "");
    case "neq":
      return normalizedValue !== (filter.value ?? "");
    case "contains":
      return normalizedValue
        .toLowerCase()
        .includes(String(filter.value ?? "").toLowerCase());
    case "is_empty":
      return normalizedValue === "";
    default:
      return true;
  }
};

export const applyFilters = (
  entities: WorkspaceEntity[],
  filters: ViewFilterCondition[],
): WorkspaceEntity[] => {
  if (filters.length === 0) {
    return entities;
  }

  return entities.filter((entity) =>
    filters.every((filter) => matchesFilter(entity, filter)),
  );
};

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export const formatRelativeTime = (
  isoString: string | null | undefined,
  locale?: string,
): string => {
  if (!isoString) {
    return "-";
  }

  const lang = useI18nStore.getState().lang;
  const currentLocale = locale ?? lang;

  const date = new Date(isoString);
  const now = Date.now();
  const diff = now - date.getTime();

  const rtf = new Intl.RelativeTimeFormat(currentLocale, {
    numeric: "auto",
    style: "narrow",
  });

  if (diff < MINUTE) {
    return rtf.format(0, "second");
  }

  const mins = Math.floor(diff / MINUTE);
  if (diff < HOUR) {
    return rtf.format(-mins, "minute");
  }

  const hrs = Math.floor(diff / HOUR);
  if (diff < DAY) {
    return rtf.format(-hrs, "hour");
  }

  const days = Math.floor(diff / DAY);
  if (diff < 7 * DAY) {
    return rtf.format(-days, "day");
  }

  return date.toLocaleDateString(currentLocale, {
    month: "short",
    day: "numeric",
  });
};

export const formatFullTimestamp = (
  isoString: string | null | undefined,
  locale?: string,
): string | null => {
  if (!isoString) {
    return null;
  }

  const currentLocale = locale ?? useI18nStore.getState().lang;

  return new Date(isoString).toLocaleString(currentLocale, {
    dateStyle: "full",
    timeStyle: "medium",
  });
};

export const applySorts = (
  entities: WorkspaceEntity[],
  sorts: { propertyId: string; desc: boolean }[],
): WorkspaceEntity[] => {
  if (sorts.length === 0) {
    return entities;
  }

  return [...entities].sort((a, b) => {
    for (const sort of sorts) {
      const fieldA = a.fields[sort.propertyId];
      const fieldB = b.fields[sort.propertyId];
      const dir = sort.desc ? -1 : 1;

      if (fieldA?.content.type === "int" && fieldB?.content.type === "int") {
        const cmp = (fieldA.content.value - fieldB.content.value) * dir;
        if (cmp !== 0) {
          return cmp;
        }
        continue;
      }

      const valueA = getFieldValue(fieldA);
      const valueB = getFieldValue(fieldB);
      const cmp = (valueA ?? "").localeCompare(valueB ?? "") * dir;

      if (cmp !== 0) {
        return cmp;
      }
    }

    return 0;
  });
};

// -- Tree utilities (shared between filesystem and table views) --

export type TreeNode = WorkspaceEntity & {
  children: TreeNode[];
};

export const buildTree = (entities: WorkspaceEntity[]): TreeNode[] => {
  const nodeMap = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];

  for (const entity of entities) {
    nodeMap.set(entity.entityId, { ...entity, children: [] });
  }

  for (const entity of entities) {
    const node = nodeMap.get(entity.entityId);
    if (!node) {
      continue;
    }

    if (entity.parentId) {
      const parent = nodeMap.get(entity.parentId);
      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    } else {
      roots.push(node);
    }
  }

  return roots;
};

/** Collect all row IDs from a tree node and its descendants. */
export const collectDescendantIds = (node: TreeNode): string[] => {
  const ids: string[] = [];
  for (const child of node.children) {
    ids.push(child.entityId);
    ids.push(...collectDescendantIds(child));
  }
  return ids;
};

/**
 * Resolve the group-by property ID for kanban views.
 *
 * Fallback order when no explicit config is set:
 * 1. A single-select property named "Status" (case-insensitive)
 * 2. The most recently created single-select manual-input property
 */
export const resolveKanbanGroupBy = (
  configuredId: string,
  properties: WorkspaceProperty[],
): string => {
  if (configuredId) {
    return configuredId;
  }

  const eligible = properties.filter((p) => p.content.type === "single-select");

  const statusProp = eligible.find((p) => p.name.toLowerCase() === "status");
  if (statusProp) {
    return statusProp.id;
  }

  const latest = eligible
    .filter((p) => p.tool.type === "manual-input")
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
    .at(0);

  return latest?.id ?? "";
};
