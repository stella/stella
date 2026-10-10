import type {
  DesktopMatter,
  DesktopTimeEntryBatch,
} from "@stll/api-contract/desktop-time-entries";

import {
  type ClipboardSourceAppVisual,
  isClipboardSourceAppVisual,
} from "../clipboard/clipboard-types";

/** Payload-free: the window re-reads the day through `activity_get_day`. */
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

export const ACTIVITY_DETAILS_ACCESS = [
  "disabled",
  "ready",
  "accessibilityRequired",
  "unavailable",
] as const;
export type ActivityDetailsAccess = (typeof ACTIVITY_DETAILS_ACCESS)[number];

export type ActivitySegment = {
  appIdentifier: string;
  appName: string;
  matterId?: string | null;
  windowTitle?: string | null;
  document?: string | null;
  /** RFC 3339 instants. */
  end: string;
  start: string;
};

export type ActivityAppExclusion = {
  identifier: string;
  name: string;
};

export type ActivityManualAssignment = {
  start: string;
  end: string;
  matterId: string;
  matter?: DesktopMatter & { clientName: string | null };
};

export type ActivityDaySnapshot = {
  /** Local calendar dates as `YYYY-MM-DD`. */
  date: string;
  pendingBatch: {
    idempotencyKey: string;
    entries: DesktopTimeEntryBatch["entries"];
    ranges: { start: string; end: string }[][];
  } | null;
  manualAssignments: ActivityManualAssignment[];
  draftedEntries: { start: string; end: string; entryId: string }[];
  timeBillingEnabled: boolean;
  earliestDate: string;
  excludedApps: ActivityAppExclusion[];
  captureDetails: boolean;
  appNameOnlyApps: ActivityAppExclusion[];
  detailsAccess: ActivityDetailsAccess;
  browserApps: ActivityAppExclusion[];
  browserTitleApps: ActivityAppExclusion[];
  otherAccountHistoryDays: number;
  persistence: ActivityPersistenceStatus;
  recordingStatus: ActivityRecordingStatus;
  retention: ActivityRetention;
  segments: ActivitySegment[];
  sourceAppVisuals: ClipboardSourceAppVisual[];
  today: string;
  unreadable: boolean;
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
const isAssignedMatter = (
  value: unknown,
): value is DesktopMatter & { clientName: string | null } => {
  if (!isRecord(value)) {
    return false;
  }
  const { id, name, reference, color, clientName } = value;
  return (
    typeof id === "string" &&
    typeof name === "string" &&
    (reference === null || typeof reference === "string") &&
    (color === null || typeof color === "string") &&
    (clientName === null || typeof clientName === "string")
  );
};
const isAssignment = (value: unknown): value is ActivityManualAssignment => {
  if (!isRecord(value) || !isRange(value)) {
    return false;
  }
  const { matterId, matter } = value;
  return (
    typeof matterId === "string" &&
    (matter === undefined ||
      (isAssignedMatter(matter) && matter.id === matterId))
  );
};
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
    isOptionalMetadata(document)
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
  if (!isRecord(value) || !isRange(value)) {
    return false;
  }
  const { entryId } = value;
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

export const isActivityDaySnapshot = (
  value: unknown,
): value is ActivityDaySnapshot => {
  if (!isRecord(value)) {
    return false;
  }
  const {
    date,
    today,
    earliestDate,
    unreadable,
    timeBillingEnabled,
    sourceAppVisuals,
    captureDetails,
    detailsAccess,
    appNameOnlyApps,
    browserApps,
    browserTitleApps,
    otherAccountHistoryDays,
    persistence,
    recordingStatus,
    retention,
    segments,
    excludedApps,
  } = value;
  return (
    typeof date === "string" &&
    typeof today === "string" &&
    typeof earliestDate === "string" &&
    typeof unreadable === "boolean" &&
    typeof timeBillingEnabled === "boolean" &&
    isReviewState(value) &&
    Array.isArray(sourceAppVisuals) &&
    sourceAppVisuals.every(isClipboardSourceAppVisual) &&
    typeof captureDetails === "boolean" &&
    isOneOf(ACTIVITY_DETAILS_ACCESS, detailsAccess) &&
    Array.isArray(appNameOnlyApps) &&
    appNameOnlyApps.every(isExclusion) &&
    Array.isArray(browserApps) &&
    browserApps.every(isExclusion) &&
    Array.isArray(browserTitleApps) &&
    browserTitleApps.every(isExclusion) &&
    typeof otherAccountHistoryDays === "number" &&
    Number.isSafeInteger(otherAccountHistoryDays) &&
    otherAccountHistoryDays >= 0 &&
    isOneOf(ACTIVITY_PERSISTENCE_STATUSES, persistence) &&
    isOneOf(ACTIVITY_RECORDING_STATUSES, recordingStatus) &&
    isOneOf(ACTIVITY_RETENTIONS, retention) &&
    Array.isArray(segments) &&
    segments.every(isSegment) &&
    Array.isArray(excludedApps) &&
    excludedApps.every(isExclusion)
  );
};
