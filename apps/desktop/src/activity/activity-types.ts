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

export type ActivityDaySnapshot = {
  /** Local calendar dates as `YYYY-MM-DD`. */
  date: string;
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
  today: string;
  unreadable: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
  const { appIdentifier, appName, start, end, windowTitle, document } = value;
  return (
    typeof appIdentifier === "string" &&
    typeof appName === "string" &&
    typeof start === "string" &&
    typeof end === "string" &&
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
