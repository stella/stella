import type {
  TimeEntry,
  TimeEntryListPage,
  TimeEntrySource,
  TimeEntryStatus,
  TimeEntrySummary,
} from "./time-entry-types";

export type {
  TimeEntry,
  TimeEntryListPage,
  TimeEntrySource,
  TimeEntryStatus,
  TimeEntrySummary,
} from "./time-entry-types";

type UnknownRecord = Record<string, unknown> & {
  activityCode?: unknown;
  billable?: unknown;
  billedMinutes?: unknown;
  createdAt?: unknown;
  currency?: unknown;
  daily?: unknown;
  dateWorked?: unknown;
  deleted?: unknown;
  durationMinutes?: unknown;
  email?: unknown;
  entryCount?: unknown;
  entryIds?: unknown;
  id?: unknown;
  image?: unknown;
  invoiceNarrative?: unknown;
  items?: unknown;
  limit?: unknown;
  members?: unknown;
  name?: unknown;
  narrative?: unknown;
  nextCursor?: unknown;
  noCharge?: unknown;
  rateAtEntry?: unknown;
  scope?: unknown;
  source?: unknown;
  splitGroupId?: unknown;
  status?: unknown;
  taskCode?: unknown;
  timerStartedAt?: unknown;
  timerStoppedAt?: unknown;
  timezoneId?: unknown;
  totalMinutes?: unknown;
  updated?: unknown;
  updatedAt?: unknown;
  userId?: unknown;
  userName?: unknown;
  viewerTotalMinutes?: unknown;
  workItemId?: unknown;
};

const isRecord = (input: unknown): input is UnknownRecord =>
  typeof input === "object" && input !== null && !Array.isArray(input);

const isNullableString = (input: unknown): input is string | null =>
  input === null || typeof input === "string";

const isInteger = (input: unknown): input is number =>
  typeof input === "number" && Number.isInteger(input);

const isTimeEntryStatus = (input: unknown): input is TimeEntryStatus =>
  input === "draft" ||
  input === "approved" ||
  input === "billed" ||
  input === "written_off";

const isTimeEntrySource = (input: unknown): input is TimeEntrySource =>
  input === "manual" || input === "timer";

const parseTimeEntry = (input: unknown): TimeEntry | null => {
  if (
    !isRecord(input) ||
    !isNullableString(input.activityCode) ||
    typeof input.billable !== "boolean" ||
    !isInteger(input.billedMinutes) ||
    typeof input.createdAt !== "string" ||
    typeof input.currency !== "string" ||
    typeof input.dateWorked !== "string" ||
    !isInteger(input.durationMinutes) ||
    typeof input.id !== "string" ||
    !isNullableString(input.invoiceNarrative) ||
    typeof input.narrative !== "string" ||
    typeof input.noCharge !== "boolean" ||
    !isInteger(input.rateAtEntry) ||
    !isTimeEntrySource(input.source) ||
    !isTimeEntryStatus(input.status) ||
    !isNullableString(input.taskCode) ||
    !isNullableString(input.timerStartedAt) ||
    !isNullableString(input.timerStoppedAt) ||
    typeof input.timezoneId !== "string" ||
    !isNullableString(input.updatedAt) ||
    !isNullableString(input.userId) ||
    !isNullableString(input.userName) ||
    !isNullableString(input.workItemId)
  ) {
    return null;
  }
  return {
    activityCode: input.activityCode,
    billable: input.billable,
    billedMinutes: input.billedMinutes,
    createdAt: input.createdAt,
    currency: input.currency,
    dateWorked: input.dateWorked,
    durationMinutes: input.durationMinutes,
    id: input.id,
    invoiceNarrative: input.invoiceNarrative,
    narrative: input.narrative,
    noCharge: input.noCharge,
    rateAtEntry: input.rateAtEntry,
    source: input.source,
    status: input.status,
    taskCode: input.taskCode,
    timerStartedAt: input.timerStartedAt,
    timerStoppedAt: input.timerStoppedAt,
    timezoneId: input.timezoneId,
    updatedAt: input.updatedAt,
    userId: input.userId,
    userName: input.userName,
    workItemId: input.workItemId,
  };
};

export const parseTimeEntryListPage = (
  input: unknown,
): TimeEntryListPage | null => {
  if (
    !isRecord(input) ||
    !Array.isArray(input.items) ||
    !isInteger(input.limit) ||
    !isNullableString(input.nextCursor)
  ) {
    return null;
  }
  const items: TimeEntry[] = [];
  for (const item of input.items) {
    const parsed = parseTimeEntry(item);
    if (parsed === null) {
      return null;
    }
    items.push(parsed);
  }
  return { items, limit: input.limit, nextCursor: input.nextCursor };
};

const parsePersonalSummary = (
  input: UnknownRecord,
): TimeEntrySummary | null => {
  if (
    input.scope !== "personal" ||
    !isInteger(input.billedMinutes) ||
    !isInteger(input.entryCount) ||
    !isInteger(input.totalMinutes)
  ) {
    return null;
  }
  return {
    billedMinutes: input.billedMinutes,
    entryCount: input.entryCount,
    scope: "personal",
    totalMinutes: input.totalMinutes,
  };
};

const parseTeamSummary = (input: UnknownRecord): TimeEntrySummary | null => {
  if (
    input.scope !== "team" ||
    !Array.isArray(input.members) ||
    !isInteger(input.viewerTotalMinutes)
  ) {
    return null;
  }
  const members: Extract<TimeEntrySummary, { scope: "team" }>["members"] = [];
  for (const member of input.members) {
    if (
      !isRecord(member) ||
      !Array.isArray(member.daily) ||
      typeof member.email !== "string" ||
      !isNullableString(member.image) ||
      typeof member.name !== "string" ||
      typeof member.userId !== "string"
    ) {
      return null;
    }
    const daily: { dateWorked: string; totalMinutes: number }[] = [];
    for (const day of member.daily) {
      if (
        !isRecord(day) ||
        typeof day.dateWorked !== "string" ||
        !isInteger(day.totalMinutes)
      ) {
        return null;
      }
      daily.push({
        dateWorked: day.dateWorked,
        totalMinutes: day.totalMinutes,
      });
    }
    members.push({
      daily,
      email: member.email,
      image: member.image,
      name: member.name,
      userId: member.userId,
    });
  }
  return {
    members,
    scope: "team",
    viewerTotalMinutes: input.viewerTotalMinutes,
  };
};

export const parseTimeEntrySummary = (
  input: unknown,
): TimeEntrySummary | null => {
  if (!isRecord(input)) {
    return null;
  }
  return input.scope === "personal"
    ? parsePersonalSummary(input)
    : parseTeamSummary(input);
};

export const parseTimeEntryIdResponse = (input: unknown) =>
  isRecord(input) && typeof input.id === "string" ? { id: input.id } : null;

export const parseTimeEntryDeleteResponse = (input: unknown) =>
  isRecord(input) && typeof input.deleted === "boolean"
    ? { deleted: input.deleted }
    : null;

export const parseTimerStartResponse = (input: unknown) =>
  isRecord(input) &&
  typeof input.id === "string" &&
  (input.timerStartedAt === undefined ||
    typeof input.timerStartedAt === "string")
    ? { id: input.id, timerStartedAt: input.timerStartedAt }
    : null;

export const parseTimerStopResponse = (input: unknown) =>
  isRecord(input) &&
  typeof input.id === "string" &&
  isInteger(input.billedMinutes) &&
  isInteger(input.durationMinutes)
    ? {
        billedMinutes: input.billedMinutes,
        durationMinutes: input.durationMinutes,
        id: input.id,
      }
    : null;

export const parseTimeEntryUpdatedResponse = (input: unknown) =>
  isRecord(input) && isInteger(input.updated)
    ? { updated: input.updated }
    : null;

export const parseTimeEntrySplitResponse = (input: unknown) => {
  if (
    !isRecord(input) ||
    !Array.isArray(input.entryIds) ||
    !input.entryIds.every((id) => typeof id === "string") ||
    typeof input.splitGroupId !== "string"
  ) {
    return null;
  }
  return { entryIds: input.entryIds, splitGroupId: input.splitGroupId };
};

export const parsePolishedTimeEntryNarrativeResponse = (input: unknown) =>
  isRecord(input) && typeof input.narrative === "string"
    ? { narrative: input.narrative }
    : null;
