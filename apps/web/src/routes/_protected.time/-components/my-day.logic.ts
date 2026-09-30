import { panic } from "better-result";

import type { MyTimeEntriesRoutes } from "@/generated/api-routes.gen";

export type MyDayPage =
  MyTimeEntriesRoutes["v1"]["time-entries"]["me"]["get"]["response"][200];
export type MyDayEntry = MyDayPage["items"][number];

export const summarizeMyDay = (pages: readonly MyDayPage[]) => {
  const totals = {
    client: { minutes: 0, running: false },
    internal: { minutes: 0, running: false },
    absence: { days: 0 },
  };
  for (const page of pages) {
    for (const entry of page.items) {
      switch (entry.activityGroup) {
        case "absence":
          totals.absence.days += entry.days;
          break;
        case "client":
        case "internal":
          if (entry.timerStartedAt !== null) {
            totals[entry.activityGroup].running = true;
          } else {
            totals[entry.activityGroup].minutes += entry.durationMinutes;
          }
          break;
        default: {
          entry satisfies never;
          return panic("Unknown My Day activity group");
        }
      }
    }
  }
  const lastPage = pages.at(-1);
  return lastPage?.nextCursor === null ? totals : null;
};
