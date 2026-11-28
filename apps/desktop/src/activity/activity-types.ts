import type { DesktopTimeEntryBatch } from "@stll/api-contract/desktop-time-entries";

import activityContract from "../../fixtures/activity-contract.json" with { type: "json" };
import {
  type ClipboardSourceAppVisual,
  isClipboardSourceAppVisual,
} from "../clipboard/clipboard-types";

/** Payload-free: the activity window re-reads the day through
 *  `activity_get_day`, the Settings window its settings through
 *  `activity_get_settings`. */
export const ACTIVITY_CHANGED_EVENT = "activity-timeline-changed";

export const ACTIVITY_RETENTIONS = ["week", "month", "quarter"] as const;
export type ActivityRetention = (typeof ACTIVITY_RETENTIONS)[number];

export const ACTIVITY_RECORDING_STATUSES = [
  "off",
  "recording",
  "paused",
] as const;
type ActivityRecordingStatus = (typeof ACTIVITY_RECORDING_STATUSES)[number];

const ACTIVITY_PERSISTENCE_STATUSES = [
  "initializing",
  "encrypted",
  "memoryOnly",
  "deletionOnly",
] as const;
type ActivityPersistenceStatus = (typeof ACTIVITY_PERSISTENCE_STATUSES)[number];

/** Whether stella AI descriptions ask before sending a suggestion's titles. */

export const ACTIVITY_DETAILS_ACCESS = [
  "disabled",
  "ready",
  "accessibilityRequired",
  "unavailable",
  // Managed policy keeps details off, whatever the user chose.
  "managed",
] as const;
export type ActivityDetailsAccess = (typeof ACTIVITY_DETAILS_ACCESS)[number];

/** Where the day review reads calendar events from; `off` reads nothing. */
export const ACTIVITY_CALENDAR_SOURCES = ["off", "microsoft365"] as const;
export type ActivityCalendarSource = (typeof ACTIVITY_CALENDAR_SOURCES)[number];

export type ActivitySegment = {
  appIdentifier: string;
  appName: string;
  matterId?: string | null;
  windowTitle?: string | null;
  document?: string | null;
  /** Time on a call in this app, whatever was in front. */
  call?: boolean;
  /** RFC 3339 instants. */
  end: string;
  start: string;
};

export type ActivityAppExclusion = {
  identifier: string;
  name: string;
};

/** A range filed under a matter by id. The matter's name is read under the
 * member's current access, never from local history. */
export type ActivityManualAssignment = {
  start: string;
  end: string;
  matterId: string;
};

export type ActivityDeletionStatus =
  keyof typeof activityContract.deletionStatuses;

/** Why Activity cannot record. */
export type ActivityStopReason = keyof typeof activityContract.stopReasons;

const isActivityStopReason = (value: unknown): value is ActivityStopReason =>
  typeof value === "string" &&
  Object.hasOwn(activityContract.stopReasons, value);

/** A stretch the member wanted recorded and Activity could not record. */
type ActivityOutage = {
  /** RFC 3339 instants. */
  start: string;
  end: string;
  reason: ActivityStopReason;
};

export type ActivityDayOutages =
  { status: "read"; outages: ActivityOutage[] } | { status: "unreadable" };

/** What the screen did while no input came. */
export type ActivityGapDisplay = keyof typeof activityContract.gapDisplays;
/** What ended a stretch with no input. */
export type ActivityGapEnd = keyof typeof activityContract.gapEnds;

/** A stretch with no input between recorded activity: times and the
 * screen's state only, never counted as recorded time. */
export type ActivityGap = {
  /** RFC 3339 instants. */
  start: string;
  end: string;
  endedBy: ActivityGapEnd;
  display: ActivityGapDisplay;
};

/** The detail-capture choices both activity views show. */
export type ActivityCaptureSettings = {
  captureDetails: boolean;
  detailsAccess: ActivityDetailsAccess;
  appNameOnlyApps: ActivityAppExclusion[];
  browserApps: ActivityAppExclusion[];
  browserTitleApps: ActivityAppExclusion[];
  /** Managed policy keeps every browser to its app name, whatever the
   * member chose; `browserTitleApps` is then empty. */
  browserTitlesManaged: boolean;
  sourceAppVisuals: ClipboardSourceAppVisual[];
};

/**
 * What `activity_get_settings` returns to the Settings window: settings,
 * deletion state and the names of the apps recorded on `date`, never the
 * timeline.
 */
export type ActivitySettingsSnapshot = ActivityCaptureSettings & {
  /** Local calendar dates as `YYYY-MM-DD`. */
  date: string;
  today: string;
  earliestDate: string;
  latestDate: string;
  deletionStatus: ActivityDeletionStatus;
  persistence: ActivityPersistenceStatus;
  retention: ActivityRetention;
  excludedApps: ActivityAppExclusion[];
  detectCalls: boolean;
  calendarSource: ActivityCalendarSource;
  otherAccountHistoryDays: number;
  apps: ActivityAppExclusion[];
};

export type ActivityDaySnapshot = {
  /** Local calendar dates as `YYYY-MM-DD`. */
  date: string;
  deletionStatus: ActivityDeletionStatus;
  pendingBatch: {
    idempotencyKey: string;
    entries: DesktopTimeEntryBatch["entries"];
    ranges: { start: string; end: string }[][];
  } | null;
  manualAssignments: ActivityManualAssignment[];
  draftedEntries: { start: string; end: string; entryId: string }[];
  earliestDate: string;
  latestDate: string;
  excludedApps: ActivityAppExclusion[];
  captureDetails: boolean;
  detectCalls: boolean;
  appNameOnlyApps: ActivityAppExclusion[];
  detailsAccess: ActivityDetailsAccess;
  browserApps: ActivityAppExclusion[];
  browserTitleApps: ActivityAppExclusion[];
  /** Managed policy keeps every browser to its app name, whatever the
   * member chose; `browserTitleApps` is then empty. */
  browserTitlesManaged: boolean;
  calendarSource: ActivityCalendarSource;
  otherAccountHistoryDays: number;
  persistence: ActivityPersistenceStatus;
  recordingStatus: ActivityRecordingStatus;
  retention: ActivityRetention;
  segments: ActivitySegment[];
  sourceAppVisuals: ClipboardSourceAppVisual[];
  today: string;
  unreadable: boolean;
  gaps: ActivityGap[];
  outages: ActivityDayOutages;
  /** Set while Activity cannot record; the history is then read-only. */
  stoppedReason: ActivityStopReason | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isRange = (value: unknown): value is { start: string; end: string } => {
  if (!isRecord(value)) {
    return false;
  }
  const { start, end } = value;
  return typeof start === "string" && typeof end === "string";
};
const isAssignment = (value: unknown): value is ActivityManualAssignment =>
  isRecord(value) && typeof value["matterId"] === "string" && isRange(value);
const isPendingEntry = (
  value: unknown,
): value is DesktopTimeEntryBatch["entries"][number] => {
  if (!isRecord(value)) {
    return false;
  }
  const {
    matterId,
    dateWorked,
    timezoneId,
    durationMinutes,
    narrative,
    billable,
  } = value;
  return (
    typeof matterId === "string" &&
    typeof dateWorked === "string" &&
    typeof timezoneId === "string" &&
    typeof durationMinutes === "number" &&
    Number.isSafeInteger(durationMinutes) &&
    durationMinutes > 0 &&
    durationMinutes <= 1440 &&
    typeof narrative === "string" &&
    typeof billable === "boolean"
  );
};
const isPendingBatch = (value: unknown) => {
  if (value === null) {
    return true;
  }
  if (!isRecord(value)) {
    return false;
  }
  const { idempotencyKey, entries, ranges } = value;
  return (
    typeof idempotencyKey === "string" &&
    Array.isArray(entries) &&
    entries.length > 0 &&
    entries.length <= 100 &&
    entries.every(isPendingEntry) &&
    Array.isArray(ranges) &&
    ranges.length === entries.length &&
    ranges.every(
      (group) =>
        Array.isArray(group) && group.length > 0 && group.every(isRange),
    )
  );
};

const isOneOf = <T extends string>(
  values: readonly T[],
  value: unknown,
): value is T => values.some((candidate) => candidate === value);

export const MAX_ACTIVITY_METADATA_BYTES = 512;

const isOptionalMetadata = (value: unknown) =>
  value === undefined ||
  value === null ||
  (typeof value === "string" &&
    new TextEncoder().encode(value).byteLength <= MAX_ACTIVITY_METADATA_BYTES &&
    !/\p{Cc}/u.test(value));

const isSegment = (value: unknown): value is ActivitySegment => {
  if (!isRecord(value)) {
    return false;
  }
  const {
    appIdentifier,
    appName,
    start,
    end,
    windowTitle,
    document,
    matterId,
    call,
  } = value;
  return (
    typeof appIdentifier === "string" &&
    typeof appName === "string" &&
    typeof start === "string" &&
    typeof end === "string" &&
    (matterId === undefined ||
      matterId === null ||
      typeof matterId === "string") &&
    isOptionalMetadata(windowTitle) &&
    isOptionalMetadata(document) &&
    (call === undefined || typeof call === "boolean")
  );
};

const isExclusion = (value: unknown): value is ActivityAppExclusion => {
  if (!isRecord(value)) {
    return false;
  }
  const { identifier, name } = value;
  return typeof identifier === "string" && typeof name === "string";
};

const isDraftedEntry = (value: unknown) => {
  if (!isRecord(value)) {
    return false;
  }
  const { entryId } = value;
  if (!isRange(value)) {
    return false;
  }
  return typeof entryId === "string";
};

const isReviewState = ({
  pendingBatch,
  manualAssignments,
  draftedEntries,
}: Record<string, unknown>) =>
  isPendingBatch(pendingBatch) &&
  Array.isArray(manualAssignments) &&
  manualAssignments.every(isAssignment) &&
  Array.isArray(draftedEntries) &&
  draftedEntries.every(isDraftedEntry);

const isCaptureSettings = ({
  captureDetails,
  detectCalls,
  detailsAccess,
  appNameOnlyApps,
  browserApps,
  browserTitleApps,
  browserTitlesManaged,
}: Record<string, unknown>) =>
  typeof captureDetails === "boolean" &&
  typeof detectCalls === "boolean" &&
  isOneOf(ACTIVITY_DETAILS_ACCESS, detailsAccess) &&
  Array.isArray(appNameOnlyApps) &&
  appNameOnlyApps.every(isExclusion) &&
  Array.isArray(browserApps) &&
  browserApps.every(isExclusion) &&
  Array.isArray(browserTitleApps) &&
  browserTitleApps.every(isExclusion) &&
  typeof browserTitlesManaged === "boolean";

/** The fields the day and settings snapshots share. */
const isSettingsState = (value: Record<string, unknown>) => {
  const {
    date,
    today,
    earliestDate,
    latestDate,
    deletionStatus,
    sourceAppVisuals,
    otherAccountHistoryDays,
    persistence,
    retention,
    excludedApps,
    calendarSource,
  } = value;
  return (
    typeof date === "string" &&
    typeof today === "string" &&
    typeof earliestDate === "string" &&
    typeof latestDate === "string" &&
    typeof deletionStatus === "string" &&
    Object.hasOwn(activityContract.deletionStatuses, deletionStatus) &&
    Array.isArray(sourceAppVisuals) &&
    sourceAppVisuals.every(isClipboardSourceAppVisual) &&
    isCaptureSettings(value) &&
    typeof otherAccountHistoryDays === "number" &&
    Number.isSafeInteger(otherAccountHistoryDays) &&
    otherAccountHistoryDays >= 0 &&
    isOneOf(ACTIVITY_PERSISTENCE_STATUSES, persistence) &&
    isOneOf(ACTIVITY_RETENTIONS, retention) &&
    isOneOf(ACTIVITY_CALENDAR_SOURCES, calendarSource) &&
    Array.isArray(excludedApps) &&
    excludedApps.every(isExclusion)
  );
};

const isOutage = (value: unknown): value is ActivityOutage => {
  if (!isRecord(value)) {
    return false;
  }
  const { reason } = value;
  return isRange(value) && isActivityStopReason(reason);
};

const isDayOutages = (value: unknown): value is ActivityDayOutages => {
  if (!isRecord(value)) {
    return false;
  }
  const { status, outages } = value;
  switch (status) {
    case "read":
      return Array.isArray(outages) && outages.every(isOutage);
    case "unreadable":
      return true;
    default:
      return false;
  }
};

const isGap = (value: unknown): value is ActivityGap => {
  if (!isRecord(value)) {
    return false;
  }
  const { endedBy, display } = value;
  return (
    isRange(value) &&
    typeof endedBy === "string" &&
    Object.hasOwn(activityContract.gapEnds, endedBy) &&
    typeof display === "string" &&
    Object.hasOwn(activityContract.gapDisplays, display)
  );
};

export const isActivityDaySnapshot = (
  value: unknown,
): value is ActivityDaySnapshot => {
  if (!isRecord(value)) {
    return false;
  }
  const {
    unreadable,
    recordingStatus,
    segments,
    gaps,
    outages,
    stoppedReason,
  } = value;
  return (
    isSettingsState(value) &&
    typeof unreadable === "boolean" &&
    isReviewState(value) &&
    isOneOf(ACTIVITY_RECORDING_STATUSES, recordingStatus) &&
    Array.isArray(segments) &&
    segments.every(isSegment) &&
    Array.isArray(gaps) &&
    gaps.every(isGap) &&
    isDayOutages(outages) &&
    (stoppedReason === null || isActivityStopReason(stoppedReason))
  );
};

export const isActivitySettingsSnapshot = (
  value: unknown,
): value is ActivitySettingsSnapshot => {
  if (!isRecord(value)) {
    return false;
  }
  const { apps } = value;
  return (
    isSettingsState(value) && Array.isArray(apps) && apps.every(isExclusion)
  );
};
