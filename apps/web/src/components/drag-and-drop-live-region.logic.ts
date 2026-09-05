import { panic } from "better-result";

const DRAG_ANNOUNCEMENT_KEY = "stella/drag-announcement";

type DragAnnouncementItem = {
  count: number;
  name: string;
  type: "item";
};

export type DragAnnouncementSubject = Pick<
  DragAnnouncementItem,
  "count" | "name"
>;

export type DragAnnouncementDestination = {
  type: "action" | "container" | "reorder";
  name: string;
};

export type DragAnnouncementPhase = "moved" | "moving";

const MESSAGE_KEY_BY_PHASE = {
  moved: {
    action: "droppedOn",
    container: "movedTo",
    reorder: "movedNear",
  },
  moving: {
    action: "movingTo",
    container: "movingTo",
    reorder: "movingNear",
  },
} as const satisfies Record<
  DragAnnouncementPhase,
  Record<DragAnnouncementDestination["type"], string>
>;

export const getDragAnnouncementMessageKey = (
  phase: DragAnnouncementPhase,
  destinationType: DragAnnouncementDestination["type"],
) => MESSAGE_KEY_BY_PHASE[phase][destinationType];

type DragAnnouncementData = DragAnnouncementItem | DragAnnouncementDestination;
type DragDataRecord = Record<string, unknown>;
type DropDataRecord = Record<string | symbol, unknown>;

export const withDragAnnouncementData = (
  data: DragDataRecord,
  name: string,
  count = 1,
): DragDataRecord => {
  data[DRAG_ANNOUNCEMENT_KEY] = { count, name, type: "item" };
  return data;
};

export const withDropAnnouncementData = (
  data: DropDataRecord,
  destination: DragAnnouncementDestination,
): DropDataRecord => {
  data[DRAG_ANNOUNCEMENT_KEY] = destination;
  return data;
};

const readAnnouncementData = (
  data: Record<string | symbol, unknown>,
): DragAnnouncementData | null => {
  const value = data[DRAG_ANNOUNCEMENT_KEY];
  if (typeof value !== "object" || value === null) {
    return null;
  }
  if (!("type" in value) || !("name" in value)) {
    return null;
  }

  const { name, type } = value;
  if (typeof name !== "string" || name.length === 0) {
    return null;
  }
  if (type === "item") {
    if (!("count" in value)) {
      return null;
    }
    const { count } = value;
    if (
      typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      count <= 0
    ) {
      return null;
    }
    return { count, name, type };
  }
  if (type === "action" || type === "container" || type === "reorder") {
    return { type, name };
  }
  return null;
};

export const getDragAnnouncementSubject = (
  data: Record<string | symbol, unknown>,
): DragAnnouncementSubject | null => {
  const announcement = readAnnouncementData(data);
  if (!announcement) {
    return null;
  }
  switch (announcement.type) {
    case "item":
      return { count: announcement.count, name: announcement.name };
    case "action":
    case "container":
    case "reorder":
      return null;
    default:
      announcement satisfies never;
      return panic(`Unhandled announcement: ${String(announcement)}`);
  }
};

type DropTargetWithData = {
  data: Record<string | symbol, unknown>;
};

export const getDropAnnouncementDestination = (
  dropTargets: readonly DropTargetWithData[],
): DragAnnouncementDestination | null => {
  for (const target of dropTargets) {
    const announcement = readAnnouncementData(target.data);
    if (!announcement) {
      continue;
    }
    switch (announcement.type) {
      case "action":
      case "container":
      case "reorder":
        return announcement;
      case "item":
        continue;
    }
  }
  return null;
};
