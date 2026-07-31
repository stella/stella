import type { MatterActivityItem } from "@/routes/_protected.workspaces/-queries";

export type ActivityRun = {
  id: string;
  items: MatterActivityItem[];
};

export const groupActivityRuns = (
  items: MatterActivityItem[],
): ActivityRun[] => {
  const groups: ActivityRun[] = [];

  for (const item of items) {
    const runKey = item.runId ? `run:${item.runId}` : null;
    const previous = groups.at(-1);
    if (runKey && previous?.id === runKey) {
      previous.items.push(item);
      continue;
    }
    groups.push({ id: runKey ?? `item:${item.id}`, items: [item] });
  }

  return groups;
};

export const activityDayKey = (activityAt: string): string => {
  const date = new Date(activityAt);
  return Number.isNaN(date.getTime())
    ? activityAt
    : `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
};
