export type TimeEntryStatus = "draft" | "approved" | "billed" | "written_off";

export type TimeEntrySource = "manual" | "timer";

export type TimeEntry = {
  activityCode: string | null;
  billable: boolean;
  billedMinutes: number;
  createdAt: string;
  currency: string;
  dateWorked: string;
  durationMinutes: number;
  id: string;
  invoiceNarrative: string | null;
  narrative: string;
  noCharge: boolean;
  rateAtEntry: number;
  source: TimeEntrySource;
  status: TimeEntryStatus;
  taskCode: string | null;
  timerStartedAt: string | null;
  timerStoppedAt: string | null;
  timezoneId: string;
  updatedAt: string | null;
  userId: string | null;
  userName: string | null;
  workItemId: string | null;
};

export type TimeEntryListPage = {
  items: TimeEntry[];
  limit: number;
  nextCursor: string | null;
};

export type TimeEntrySummary =
  | {
      billedMinutes: number;
      entryCount: number;
      scope: "personal";
      totalMinutes: number;
    }
  | {
      members: {
        daily: { dateWorked: string; totalMinutes: number }[];
        email: string;
        image: string | null;
        name: string;
        userId: string;
      }[];
      scope: "team";
      viewerTotalMinutes: number;
    };
