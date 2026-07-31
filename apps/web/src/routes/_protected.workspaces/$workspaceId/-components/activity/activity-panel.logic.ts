import type { MatterActivityItem } from "@/routes/_protected.workspaces/-queries";

const DOCUMENT_BATCH_WINDOW_MS = 60_000;

export type ActivityGroup =
  | {
      id: string;
      items: [MatterActivityItem, ...MatterActivityItem[]];
      type: "automation_run";
    }
  | {
      id: string;
      items: [MatterActivityItem, ...MatterActivityItem[]];
      type: "document_batch";
    }
  | {
      id: string;
      items: [MatterActivityItem];
      type: "single";
    };

const isBatchableDocumentCreate = (item: MatterActivityItem) =>
  item.runId === null &&
  item.action === "create" &&
  item.target.kind === "document" &&
  item.performer.type === "user";

const hasSamePerformer = (
  left: MatterActivityItem,
  right: MatterActivityItem,
) => {
  if (left.performer.type !== "user" || right.performer.type !== "user") {
    return false;
  }
  return left.performer.id !== null && left.performer.id === right.performer.id;
};

const isWithinDocumentBatchWindow = (
  anchor: MatterActivityItem,
  candidate: MatterActivityItem,
) => {
  const anchorTime = new Date(anchor.activityAt).getTime();
  const candidateTime = new Date(candidate.activityAt).getTime();
  return (
    Number.isFinite(anchorTime) &&
    Number.isFinite(candidateTime) &&
    Math.abs(anchorTime - candidateTime) <= DOCUMENT_BATCH_WINDOW_MS
  );
};

export const groupActivityItems = (
  items: MatterActivityItem[],
): ActivityGroup[] => {
  const groups: ActivityGroup[] = [];

  for (const item of items) {
    const previous = groups.at(-1);
    if (
      item.runId &&
      previous?.type === "automation_run" &&
      previous.items[0].runId === item.runId
    ) {
      previous.items.push(item);
      continue;
    }
    if (
      isBatchableDocumentCreate(item) &&
      previous?.type === "document_batch" &&
      hasSamePerformer(previous.items[0], item) &&
      isWithinDocumentBatchWindow(previous.items[0], item)
    ) {
      previous.items.push(item);
      continue;
    }
    if (item.runId) {
      groups.push({
        id: `run:${item.runId}:${item.id}`,
        items: [item],
        type: "automation_run",
      });
      continue;
    }
    if (isBatchableDocumentCreate(item)) {
      groups.push({
        id: `document-batch:${item.id}`,
        items: [item],
        type: "document_batch",
      });
      continue;
    }
    groups.push({ id: `item:${item.id}`, items: [item], type: "single" });
  }

  return groups;
};

export const activityDayKey = (activityAt: string): string => {
  const date = new Date(activityAt);
  return Number.isNaN(date.getTime())
    ? activityAt
    : `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
};

export const expandActivityGroupsForList = (
  groups: ActivityGroup[],
): ActivityGroup[] =>
  groups.flatMap((group) =>
    group.type === "automation_run"
      ? group.items.map((item) => ({
          id: `item:${item.id}`,
          items: [item],
          type: "single" as const,
        }))
      : [group],
  );
