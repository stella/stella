/** Payload-free: the window re-reads the day through `activity_get_day`. */
export const ACTIVITY_CHANGED_EVENT = "activity-timeline-changed";

export const ACTIVITY_RETENTIONS = ["week", "month", "quarter"] as const;
export type ActivityRetention = (typeof ACTIVITY_RETENTIONS)[number];

export const ACTIVITY_RECORDING_STATUSES = [
  "off",
  "recording",
  "paused",
] as const;
export type ActivityRecordingStatus =
  (typeof ACTIVITY_RECORDING_STATUSES)[number];

const ACTIVITY_PERSISTENCE_STATUSES = [
  "initializing",
  "encrypted",
  "memoryOnly",
  "deletionOnly",
] as const;
export type ActivityPersistenceStatus =
  (typeof ACTIVITY_PERSISTENCE_STATUSES)[number];

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

const isSegment = (value: unknown): value is ActivitySegment =>
  isRecord(value) &&
  typeof value["appIdentifier"] === "string" &&
  typeof value["appName"] === "string" &&
  typeof value["start"] === "string" &&
  typeof value["end"] === "string" &&
  isOptionalMetadata(value["windowTitle"]) &&
  isOptionalMetadata(value["document"]);

const isExclusion = (value: unknown): value is ActivityAppExclusion =>
  isRecord(value) &&
  typeof value["identifier"] === "string" &&
  typeof value["name"] === "string";

export const isActivityDaySnapshot = (
  value: unknown,
): value is ActivityDaySnapshot =>
  isRecord(value) &&
  typeof value["date"] === "string" &&
  typeof value["today"] === "string" &&
  typeof value["earliestDate"] === "string" &&
  typeof value["unreadable"] === "boolean" &&
  typeof value["timeBillingEnabled"] === "boolean" &&
  Array.isArray(value["draftedEntries"]) &&
  value["draftedEntries"].every(
    (entry) =>
      isRecord(entry) &&
      typeof entry["start"] === "string" &&
      typeof entry["end"] === "string" &&
      typeof entry["entryId"] === "string",
  ) &&
