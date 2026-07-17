import { getFormatter, getFormattingLocale } from "@/i18n/i18n-store";
import { startOfWeek } from "@/i18n/week";
import { getRelativeTimeFormatter } from "@/lib/relative-time";
import { DAY_IN_MS } from "@/lib/time";
import type {
  WorkspaceEntity,
  WorkspaceField,
  WorkspaceProperty,
} from "@/lib/types";
import type { TableTreeNode } from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";

const DOCUMENT_ROUTE_SUFFIX = "/document";

type InternalColId = "select" | "add-property";

export const getInternalColId = (col: InternalColId): InternalColId => col;

export const isWorkspaceDocumentRoutePath = (pathname: string) =>
  pathname.endsWith(DOCUMENT_ROUTE_SUFFIX);

// -- Internal property IDs (metadata columns stored in view config) --

const INTERNAL_PROPERTIES = [
  "name",
  "created-by",
  "updated-at",
  "version",
  "kind",
  "status",
  "priority",
  "due-date",
] as const;

type InternalProperty = (typeof INTERNAL_PROPERTIES)[number];
export type InternalPropertyId = `_${InternalProperty}`;

export const getInternalPropertyId = (
  p: InternalProperty,
): InternalPropertyId => `_${p}`;

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
        ? getFormatter().dateTime(new Date(field.content.value), {
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
    case "clip":
      return field.content.url;
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

  const fields = Object.values(entity.fields).filter(
    (field): field is WorkspaceField => field !== undefined,
  );
  const fileField = fields.find((f) => f.content.type === "file");

  if (fileField?.content.type === "file" && fileField.content.fileName) {
    return fileField.content.fileName;
  }

  const textField = fields.find((f) => f.content.type === "text");

  if (textField?.content.type === "text" && textField.content.value.trim()) {
    return textField.content.value;
  }

  return (() => {
    if (entity.kind === "folder") {
      return "Untitled Folder";
    }
    if (entity.kind === "task") {
      return "Untitled Task";
    }
    return "Untitled";
  })();
};

export const getFirstFile = (entity: WorkspaceEntity) => {
  for (const field of Object.values(entity.fields)) {
    if (!field) {
      continue;
    }

    if (field.content.type === "file") {
      return {
        fieldId: field.id,
        propertyId: field.propertyId,
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

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = DAY_IN_MS;

export const formatRelativeTime = (
  isoString: string | null | undefined,
  locale?: string,
): string => {
  if (!isoString) {
    return "-";
  }

  const currentLocale = locale ?? getFormattingLocale();

  const date = new Date(isoString);
  const now = Date.now();
  const diff = now - date.getTime();

  const rtf = getRelativeTimeFormatter(currentLocale);

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

/** Start of the current week (local time), per the locale's first weekday. */
export const getWeekStart = (locale: string): Date =>
  startOfWeek(new Date(), locale);

/** Format a Date as `YYYY-MM-DD` in local time (not UTC). */
export const toISODate = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

export const formatFullTimestamp = (
  isoString: string | null | undefined,
  locale?: string,
): string | null => {
  if (!isoString) {
    return null;
  }

  const currentLocale = locale ?? getFormattingLocale();

  return new Date(isoString).toLocaleString(currentLocale, {
    dateStyle: "full",
    timeStyle: "medium",
  });
};

// -- Tree utilities (shared between filesystem and table views) --

/**
 * Entity IDs that sit on a parentId cycle (a node reachable from itself by
 * walking parentId pointers). Uses the standard functional-graph cycle scan:
 * each entity has at most one outgoing edge (its parentId), so walking from
 * an unvisited node either terminates at a root/missing parent or re-enters
 * a node already on the current path, which marks the remainder of that path
 * (the cycle itself, not any acyclic tail leading into it) as cyclic.
 */
const findCyclicEntityIds = (
  entities: readonly WorkspaceEntity[],
): ReadonlySet<string> => {
  const parentIdOf = new Map<string, string | null>();
  for (const entity of entities) {
    parentIdOf.set(entity.entityId, entity.parentId);
  }

  const status = new Map<string, "visiting" | "done">();
  const inCycle = new Set<string>();

  for (const entity of entities) {
    if (status.has(entity.entityId)) {
      continue;
    }

    const path: string[] = [];
    const pathIndex = new Map<string, number>();
    let currentId: string | null = entity.entityId;

    while (currentId !== null) {
      const currentStatus = status.get(currentId);
      if (currentStatus === "done") {
        break;
      }
      if (currentStatus === "visiting") {
        const cycleStart = pathIndex.get(currentId) ?? 0;
        for (const id of path.slice(cycleStart)) {
          inCycle.add(id);
        }
        break;
      }

      status.set(currentId, "visiting");
      pathIndex.set(currentId, path.length);
      path.push(currentId);

      const parentId = parentIdOf.get(currentId);
      currentId = parentId && parentIdOf.has(parentId) ? parentId : null;
    }

    for (const id of path) {
      status.set(id, "done");
    }
  }

  return inCycle;
};

export const buildTree = (
  entities: readonly WorkspaceEntity[],
): TableTreeNode[] => {
  const nodeMap = new Map<string, TableTreeNode>();
  const roots: TableTreeNode[] = [];

  for (const entity of entities) {
    nodeMap.set(entity.entityId, { ...entity, children: [] });
  }

  const cyclicEntityIds = findCyclicEntityIds(entities);

  for (const entity of entities) {
    const node = nodeMap.get(entity.entityId);
    if (!node) {
      continue;
    }

    // Nodes on a parentId cycle are deliberately cut loose as roots instead
    // of being attached under their (equally cyclic) parent: this keeps them
    // visible in the tree rather than silently dropped, and guarantees the
    // resulting forest is acyclic.
    const parent =
      entity.parentId && !cyclicEntityIds.has(entity.entityId)
        ? nodeMap.get(entity.parentId)
        : undefined;

    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
};

export const toTableEntities = (
  entities: readonly WorkspaceEntity[],
): TableTreeNode[] => {
  const hasFolders = entities.some((e) => e.kind === "folder");
  return hasFolders
    ? buildTree(entities)
    : entities.map((e) => ({ ...e, children: [] }));
};

/**
 * Find a node by ID in a tree (depth-first).
 *
 * Guards against a corrupted/externally-built tree that loops back on
 * itself: a `visited` set stops a node's children from being re-queued once
 * they have already been expanded, so the walk always terminates even if
 * `children` contains a cycle.
 */
export const findNode = (
  roots: readonly TableTreeNode[],
  targetId: string,
): TableTreeNode | null => {
  const stack = [...roots];
  const visited = new Set<string>();
  let node = stack.pop();
  while (node) {
    if (node.entityId === targetId) {
      return node;
    }
    if (visited.has(node.entityId)) {
      node = stack.pop();
      continue;
    }
    visited.add(node.entityId);
    for (const child of node.children) {
      stack.push(child);
    }
    node = stack.pop();
  }
  return null;
};

/**
 * Count all descendants (non-recursive, stack-based).
 *
 * Guards against a cyclic `children` graph the same way {@link findNode}
 * does: each entityId is counted at most once, so the walk terminates.
 */
export const countDescendants = (node: TableTreeNode): number => {
  let count = 0;
  const visited = new Set<string>([node.entityId]);
  const stack = [...node.children];
  let child = stack.pop();
  while (child) {
    if (visited.has(child.entityId)) {
      child = stack.pop();
      continue;
    }
    visited.add(child.entityId);
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
  properties: readonly WorkspaceProperty[],
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
