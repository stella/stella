import type { MatterActivityItem } from "@/lib/workspaces/queries";

const DOCUMENT_BATCH_WINDOW_MS = 60_000;

type ActivityTriggerType = MatterActivityItem["trigger"]["type"];
type VisibleActivityTriggerType = Exclude<ActivityTriggerType, "direct">;

const VISIBLE_ACTIVITY_TRIGGER_TYPES = {
  agent_delegation: "agent_delegation",
  credential: "credential",
  direct: null,
  schedule: "schedule",
  system: "system",
  user_dispatch: "user_dispatch",
  webhook: "webhook",
} as const satisfies Record<
  ActivityTriggerType,
  VisibleActivityTriggerType | null
>;

export const resolveVisibleActivityTriggerType = (
  type: ActivityTriggerType,
): VisibleActivityTriggerType | null => VISIBLE_ACTIVITY_TRIGGER_TYPES[type];

export const activityDayKey = (activityAt: string): string => {
  const date = new Date(activityAt);
  return Number.isNaN(date.getTime())
    ? activityAt
    : `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
};

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
  return left.performer.id === right.performer.id;
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

const hasSameActivityDay = (
  left: MatterActivityItem,
  right: MatterActivityItem,
) => activityDayKey(left.activityAt) === activityDayKey(right.activityAt);

export const groupActivityItems = (
  items: MatterActivityItem[],
): ActivityGroup[] => {
  const groups: ActivityGroup[] = [];

  for (const item of items) {
    const previous = groups.at(-1);
    if (
      item.runId &&
      previous?.type === "automation_run" &&
      previous.items[0].runId === item.runId &&
      hasSameActivityDay(previous.items[0], item)
    ) {
      previous.items.push(item);
      continue;
    }
    if (
      isBatchableDocumentCreate(item) &&
      previous?.type === "document_batch" &&
      hasSamePerformer(previous.items[0], item) &&
      hasSameActivityDay(previous.items[0], item) &&
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

export const toSingleActivityGroup = (
  item: MatterActivityItem,
): ActivityGroup => ({
  id: `item:${item.id}`,
  items: [item],
  type: "single",
});

export const resolveSelectedActivityGroup = (
  groups: ActivityGroup[],
  selectedGroupId: string | null,
): ActivityGroup | null => {
  if (!selectedGroupId) {
    return null;
  }
  for (const group of groups) {
    if (group.id === selectedGroupId) {
      return group;
    }
    const selectedItem = group.items.find(
      ({ id }) => `item:${id}` === selectedGroupId,
    );
    if (selectedItem) {
      return toSingleActivityGroup(selectedItem);
    }
  }
  return null;
};
