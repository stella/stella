export type TimeEntryStatus = "draft" | "approved" | "billed" | "written_off";

export type TimeEntrySource = "manual" | "timer" | "suggested";

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
      totalTeamMinutes: number;
      viewerTotalMinutes: number;
    };

/**
 * One thing the timekeeper touched inside a suggested entry. `chat_thread`
 * evidence names the conversation; `resource` evidence names the document,
 * task, or other matter record an audit row was written for. `name` is null
 * when the record no longer exists or has no display name.
 */
export type TimeEntrySuggestionEvidence =
  | {
      type: "chat_thread";
      id: string;
      title: string;
      messageCount: number;
    }
  | {
      type: "resource";
      id: string;
      resourceType: string;
      name: string | null;
      actions: string[];
    };

export type TimeEntrySuggestion = {
  /** Stable identity of the cluster for the day: survives later signals extending it. */
  fingerprint: string;
  startedAt: string;
  endedAt: string;
  durationMinutes: number;
  signalCount: number;
  evidence: TimeEntrySuggestionEvidence[];
};

export type TimeEntrySuggestionsResponse = {
  date: string;
  /** Sum of suggested minutes still awaiting a decision. */
  activeMinutes: number;
  items: TimeEntrySuggestion[];
};

export type TimeEntrySuggestionDecision = {
  fingerprint: string;
  status: "accepted" | "dismissed";
  timeEntryId: string | null;
};
