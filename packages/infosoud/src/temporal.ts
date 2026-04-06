import type { ParsedInfoSoudDate, ParsedInfoSoudDateTime } from "./types.js";

const ISO_DATE_PATTERN = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/u;
const ISO_DATE_TIME_PATTERN =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2})(?::(?<second>\d{2}))?$/u;
const CZECH_DATE_PATTERN =
  /^(?<day>\d{1,2})\.(?<month>\d{1,2})\.(?<year>\d{4})$/u;
const CZECH_DATE_TIME_PATTERN =
  /^(?<day>\d{1,2})\.(?<month>\d{1,2})\.(?<year>\d{4})\s+(?<hour>\d{1,2}):(?<minute>\d{2})(?::(?<second>\d{2}))?$/u;
const PRAGUE_TIME_ZONE = "Europe/Prague";
const PRAGUE_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  month: "2-digit",
  second: "2-digit",
  timeZone: PRAGUE_TIME_ZONE,
  year: "numeric",
});

type DateParts = {
  readonly day: number;
  readonly month: number;
  readonly year: number;
};

type DateTimeParts = DateParts & {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
};

const pad = (value: number): string => String(value).padStart(2, "0");

const parseInteger = (value: string | undefined): number | null => {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
};

const buildUtcUnixMs = ({
  day,
  hour = 0,
  minute = 0,
  month,
  second = 0,
  year,
}: DateTimeParts | (DateParts & Partial<DateTimeParts>)): number | null => {
  const candidate = new Date(
    Date.UTC(year, month - 1, day, hour, minute, second),
  );

  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day ||
    candidate.getUTCHours() !== hour ||
    candidate.getUTCMinutes() !== minute ||
    candidate.getUTCSeconds() !== second
  ) {
    return null;
  }

  return candidate.getTime();
};

const getFormatPart = (
  parts: readonly Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): number | null => {
  const value = parts.find((part) => part.type === type)?.value;
  if (!value) {
    return null;
  }

  return parseInteger(value);
};

const getPragueDateTimeParts = (unixMs: number): DateTimeParts | null => {
  const parts = PRAGUE_DATE_TIME_FORMATTER.formatToParts(new Date(unixMs));
  const year = getFormatPart(parts, "year");
  const month = getFormatPart(parts, "month");
  const day = getFormatPart(parts, "day");
  const hour = getFormatPart(parts, "hour");
  const minute = getFormatPart(parts, "minute");
  const second = getFormatPart(parts, "second");

  if (
    year === null ||
    month === null ||
    day === null ||
    hour === null ||
    minute === null ||
    second === null
  ) {
    return null;
  }

  return {
    day,
    hour,
    minute,
    month,
    second,
    year,
  };
};

const getPragueTimeZoneOffsetMs = (unixMs: number): number | null => {
  const parts = getPragueDateTimeParts(unixMs);
  if (!parts) {
    return null;
  }

  const zonedUnixMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );

  return zonedUnixMs - unixMs;
};

const areDateTimePartsEqual = (
  left: DateTimeParts,
  right: DateTimeParts,
): boolean =>
  left.day === right.day &&
  left.hour === right.hour &&
  left.minute === right.minute &&
  left.month === right.month &&
  left.second === right.second &&
  left.year === right.year;

const buildPragueLocalUnixMs = (parts: DateTimeParts): number | null => {
  const naiveUnixMs = buildUtcUnixMs(parts);
  if (naiveUnixMs === null) {
    return null;
  }

  let candidateUnixMs = naiveUnixMs;

  // InfoSoud datetimes are Czech local wall times; convert them to a real UTC
  // instant, including DST shifts, before comparing against Date.now().
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const offsetMs = getPragueTimeZoneOffsetMs(candidateUnixMs);
    if (offsetMs === null) {
      return null;
    }

    const nextCandidateUnixMs = naiveUnixMs - offsetMs;
    if (nextCandidateUnixMs === candidateUnixMs) {
      break;
    }

    candidateUnixMs = nextCandidateUnixMs;
  }

  const resolvedParts = getPragueDateTimeParts(candidateUnixMs);
  if (!resolvedParts || !areDateTimePartsEqual(parts, resolvedParts)) {
    return null;
  }

  return candidateUnixMs;
};

const toIsoDate = ({ day, month, year }: DateParts): string =>
  `${year}-${pad(month)}-${pad(day)}`;

const toIsoDateTime = ({
  day,
  hour,
  minute,
  month,
  second,
  year,
}: DateTimeParts): string =>
  `${toIsoDate({ day, month, year })}T${pad(hour)}:${pad(minute)}:${pad(second)}`;

const toNormalizedRaw = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed || null;
};

const parseDateParts = (value: string): DateParts | null => {
  const isoMatch = ISO_DATE_PATTERN.exec(value);
  if (isoMatch?.groups) {
    const year = parseInteger(isoMatch.groups.year);
    const month = parseInteger(isoMatch.groups.month);
    const day = parseInteger(isoMatch.groups.day);
    if (year !== null && month !== null && day !== null) {
      return { day, month, year };
    }
  }

  const czechMatch = CZECH_DATE_PATTERN.exec(value);
  if (czechMatch?.groups) {
    const year = parseInteger(czechMatch.groups.year);
    const month = parseInteger(czechMatch.groups.month);
    const day = parseInteger(czechMatch.groups.day);
    if (year !== null && month !== null && day !== null) {
      return { day, month, year };
    }
  }

  return null;
};

const parseDateTimeParts = (value: string): DateTimeParts | null => {
  const isoMatch = ISO_DATE_TIME_PATTERN.exec(value);
  if (isoMatch?.groups) {
    const year = parseInteger(isoMatch.groups.year);
    const month = parseInteger(isoMatch.groups.month);
    const day = parseInteger(isoMatch.groups.day);
    const hour = parseInteger(isoMatch.groups.hour);
    const minute = parseInteger(isoMatch.groups.minute);
    const second = parseInteger(isoMatch.groups.second) ?? 0;
    if (
      year !== null &&
      month !== null &&
      day !== null &&
      hour !== null &&
      minute !== null
    ) {
      return { day, hour, minute, month, second, year };
    }
  }

  const czechMatch = CZECH_DATE_TIME_PATTERN.exec(value);
  if (czechMatch?.groups) {
    const year = parseInteger(czechMatch.groups.year);
    const month = parseInteger(czechMatch.groups.month);
    const day = parseInteger(czechMatch.groups.day);
    const hour = parseInteger(czechMatch.groups.hour);
    const minute = parseInteger(czechMatch.groups.minute);
    const second = parseInteger(czechMatch.groups.second) ?? 0;
    if (
      year !== null &&
      month !== null &&
      day !== null &&
      hour !== null &&
      minute !== null
    ) {
      return { day, hour, minute, month, second, year };
    }
  }

  return null;
};

export const parseInfoSoudDate = (
  value: string | null | undefined,
): ParsedInfoSoudDate => {
  const raw = toNormalizedRaw(value);
  if (!raw) {
    return { isoDate: null, raw: null, unixMs: null };
  }

  const parts = parseDateParts(raw);
  if (!parts) {
    return { isoDate: null, raw, unixMs: null };
  }

  const unixMs = buildUtcUnixMs(parts);
  if (unixMs === null) {
    return { isoDate: null, raw, unixMs: null };
  }

  return {
    isoDate: toIsoDate(parts),
    raw,
    unixMs,
  };
};

export const parseInfoSoudDateTime = (
  value: string | null | undefined,
): ParsedInfoSoudDateTime => {
  const raw = toNormalizedRaw(value);
  if (!raw) {
    return { isoDateTime: null, raw: null, unixMs: null };
  }

  const parts = parseDateTimeParts(raw);
  if (!parts) {
    return { isoDateTime: null, raw, unixMs: null };
  }

  const unixMs = buildPragueLocalUnixMs(parts);
  if (unixMs === null) {
    return { isoDateTime: null, raw, unixMs: null };
  }

  return {
    isoDateTime: toIsoDateTime(parts),
    raw,
    unixMs,
  };
};
