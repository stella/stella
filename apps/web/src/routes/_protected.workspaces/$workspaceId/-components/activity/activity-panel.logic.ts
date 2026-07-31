import type { MatterActivityItem } from "@/routes/_protected.workspaces/-queries";

export type ActivityRun = {
  id: string;
  items: MatterActivityItem[];
  runId: string | null;
};

export const groupActivityRuns = (
  items: MatterActivityItem[],
): ActivityRun[] => {
  const groups: ActivityRun[] = [];

  for (const item of items) {
    const runKey = item.runId ? `run:${item.runId}` : null;
    const previous = groups.at(-1);
    if (item.runId && previous?.runId === item.runId) {
      previous.items.push(item);
      continue;
    }
    groups.push({
      id: runKey ? `${runKey}:${item.id}` : `item:${item.id}`,
      items: [item],
      runId: item.runId,
    });
  }

  return groups;
};

export const activityDayKey = (activityAt: string): string => {
  const date = new Date(activityAt);
  return Number.isNaN(date.getTime())
    ? activityAt
    : `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
};
