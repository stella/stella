import type { CSSProperties } from "react";

import type { Column } from "@tanstack/react-table";
import type { RowData } from "@tanstack/table-core";

import { useI18nStore } from "@/i18n/i18n-store";
import type {
  ViewFilterCondition,
  WorkspaceEntity,
  WorkspaceField,
  WorkspaceProperty,
} from "@/lib/types";
import type { TableTreeNode } from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";

type InternalColId = "select" | "add-property";

const internalColMap: Record<InternalColId, null> = {
  select: null,
  "add-property": null,
};

export const getInternalColId = (col: InternalColId): InternalColId => col;

export const isInternalColId = (id: string): id is InternalColId =>
  Object.keys(internalColMap).includes(id);

// -- Internal property IDs (metadata columns stored in view config) --

const INTERNAL_PROPERTIES = [
  "created-by",
  "updated-at",
  "version",
  "kind",
] as const;

type InternalProperty = (typeof INTERNAL_PROPERTIES)[number];
export type InternalPropertyId = `_${InternalProperty}`;

export const getInternalPropertyId = (
  p: InternalProperty,
): InternalPropertyId => `_${p}`;

export const isInternalPropertyId = (id: string): id is InternalPropertyId =>
  id.startsWith("_") &&
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: guarded by INTERNAL_PROPERTIES.includes
  INTERNAL_PROPERTIES.includes(id.slice(1) as InternalProperty);

export const getPinningStyles = <T = WorkspaceEntity>(
  column: Column<T>,
): CSSProperties => {
  const canPin = column.getCanPin();

  // The add-property column is sticky on the right so the "+"
  // button stays visible during horizontal scroll.
  if (column.id === getInternalColId("add-property")) {
    return {
      boxShadow: "2px 0 0px 0px var(--color-border) inset",
      position: "sticky",
      right: 0,
      width: column.getSize(),
      zIndex: 2,
    };
  }

  if (!canPin) {
    return {};
  }

  const isPinned = column.getIsPinned() === "left";
  const isSelectColumn = column.id === getInternalColId("select");
  const isLastPinnedColumn =
    !isSelectColumn && isPinned && column.getIsLastColumn("left");

  return {
    boxShadow: isLastPinnedColumn
      ? "-2px 0 0px 0px var(--color-border) inset"
      : undefined,
    left: isPinned ? `${column.getStart("left")}px` : undefined,
    position: isPinned ? "sticky" : undefined,
    width: column.getSize(),
    zIndex: isPinned ? (isSelectColumn ? 3 : 2) : undefined,
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
  // oxlint-disable-next-line consistent-type-definitions
  interface ColumnMeta<TData extends RowData, TValue> {
    /** Render cell text in muted-foreground. */
    muted?: boolean;
  }
}

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
    case "error":
    case "pending":
    case "unsupported":
      return "";
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

  return [...entities].toSorted((a, b) => {
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

// -- Entity parsing --

type RawEntity = {
  entityId: string;
  kind: WorkspaceEntity["kind"];
  name: string | null;
  parentId: string | null;
  createdAt: string;
  createdBy: string | null;
  createdByImage: string | null;
  updatedAt: string | null;
  version: number;
  fields: {
    id: string;
    propertyId: string;
    entityId: string;
    content: WorkspaceField["content"];
  }[];
};

export const parseEntities = (entities: RawEntity[]): WorkspaceEntity[] =>
  entities.map((e) => ({
    entityId: e.entityId,
    kind: e.kind,
    name: e.name,
    parentId: e.parentId,
    createdAt: e.createdAt,
    createdBy: e.createdBy,
    createdByImage: e.createdByImage,
    updatedAt: e.updatedAt,
    version: e.version,
    fields: e.fields.reduce<Record<string, WorkspaceField>>((acc, field) => {
      acc[field.propertyId] = {
        id: field.id,
        entityId: e.entityId,
        content: field.content,
      };
      return acc;
    }, {}),
  }));

// -- Tree utilities (shared between filesystem and table views) --

export const buildTree = (entities: WorkspaceEntity[]): TableTreeNode[] => {
  const nodeMap = new Map<string, TableTreeNode>();
  const roots: TableTreeNode[] = [];

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

export const toTableEntities = (
  entities: WorkspaceEntity[],
): TableTreeNode[] => {
  const hasFolders = entities.some((e) => e.kind === "folder");
  return hasFolders
    ? buildTree(entities)
    : entities.map((e) => ({ ...e, children: [] }));
};

/** Find a node by ID in a tree (depth-first). */
export const findNode = (
  roots: TableTreeNode[],
  targetId: string,
): TableTreeNode | null => {
  const stack = [...roots];
  let node = stack.pop();
  while (node) {
    if (node.entityId === targetId) {
      return node;
    }
    for (const child of node.children) {
      stack.push(child);
    }
    node = stack.pop();
  }
  return null;
};

/** Collect all row IDs from a tree node and its descendants. */
export const collectDescendantIds = (node: TableTreeNode): string[] => {
  const ids: string[] = [];
  const stack = [...node.children];
  let child = stack.pop();
  while (child) {
    ids.push(child.entityId);
    for (const grandchild of child.children) {
      stack.push(grandchild);
    }
    child = stack.pop();
  }
  return ids;
};

/** Count all descendants (non-recursive, stack-based). */
export const countDescendants = (node: TableTreeNode): number => {
  let count = 0;
  const stack = [...node.children];
  let child = stack.pop();
  while (child) {
    count += 1;
    for (const grandchild of child.children) {
      stack.push(grandchild);
    }
    child = stack.pop();
  }
  return count;
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
    .toSorted(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
    .at(0);

  return latest?.id ?? "";
};
