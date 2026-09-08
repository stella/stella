import { Result } from "better-result";
import { Temporal } from "temporal-polyfill/full";

import type { ParsedInfoSoudDate, ParsedInfoSoudDateTime } from "./types.js";

const ISO_DATE_PATTERN = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/u;
const ISO_DATE_TIME_PATTERN =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2})(?::(?<second>\d{2}))?$/u;
const CZECH_DATE_PATTERN =
  /^(?<day>\d{1,2})\.(?<month>\d{1,2})\.(?<year>\d{4})$/u;
const CZECH_DATE_TIME_PATTERN =
  /^(?<day>\d{1,2})\.(?<month>\d{1,2})\.(?<year>\d{4})\s+(?<hour>\d{1,2}):(?<minute>\d{2})(?::(?<second>\d{2}))?$/u;
const PRAGUE_TIME_ZONE = "Europe/Prague";

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

const parseInteger = (value: string | undefined): number | null => {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
};

const buildPlainDate = (parts: DateParts): Temporal.PlainDate | null =>
  Result.try(() =>
    Temporal.PlainDate.from(parts, { overflow: "reject" }),
  ).unwrapOr(null);

const buildPlainDateTime = (
  parts: DateTimeParts,
): Temporal.PlainDateTime | null =>
  Result.try(() =>
    Temporal.PlainDateTime.from(parts, { overflow: "reject" }),
  ).unwrapOr(null);

const buildPragueLocalUnixMs = (
  plainDateTime: Temporal.PlainDateTime,
): number | null => {
  // The source supplies a Czech wall time without an offset. Preserve the
  // established policy for the repeated autumn hour by choosing its later
  // occurrence. The same policy shifts a nonexistent spring time forward, so
  // require an exact wall-time round trip to reject that gap.
  const zonedDateTime = plainDateTime.toZonedDateTime(PRAGUE_TIME_ZONE, {
    disambiguation: "later",
  });
  if (!zonedDateTime.toPlainDateTime().equals(plainDateTime)) {
    return null;
  }
  return zonedDateTime.epochMilliseconds;
};

const toNormalizedRaw = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed || null;
};

const parseDateParts = (value: string): DateParts | null => {
  const isoMatch = ISO_DATE_PATTERN.exec(value);
  if (isoMatch?.groups) {
    const year = parseInteger(isoMatch.groups["year"]);
    const month = parseInteger(isoMatch.groups["month"]);
    const day = parseInteger(isoMatch.groups["day"]);
    if (year !== null && month !== null && day !== null) {
      return { day, month, year };
    }
  }

  const czechMatch = CZECH_DATE_PATTERN.exec(value);
  if (czechMatch?.groups) {
    const year = parseInteger(czechMatch.groups["year"]);
    const month = parseInteger(czechMatch.groups["month"]);
    const day = parseInteger(czechMatch.groups["day"]);
    if (year !== null && month !== null && day !== null) {
      return { day, month, year };
    }
  }

  return null;
};

const parseDateTimeParts = (value: string): DateTimeParts | null => {
  const isoMatch = ISO_DATE_TIME_PATTERN.exec(value);
  if (isoMatch?.groups) {
    const year = parseInteger(isoMatch.groups["year"]);
    const month = parseInteger(isoMatch.groups["month"]);
    const day = parseInteger(isoMatch.groups["day"]);
    const hour = parseInteger(isoMatch.groups["hour"]);
    const minute = parseInteger(isoMatch.groups["minute"]);
    const second = parseInteger(isoMatch.groups["second"]) ?? 0;
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
    const year = parseInteger(czechMatch.groups["year"]);
    const month = parseInteger(czechMatch.groups["month"]);
    const day = parseInteger(czechMatch.groups["day"]);
    const hour = parseInteger(czechMatch.groups["hour"]);
    const minute = parseInteger(czechMatch.groups["minute"]);
    const second = parseInteger(czechMatch.groups["second"]) ?? 0;
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
  const plainDate = parts === null ? null : buildPlainDate(parts);
  if (plainDate === null) {
    return { isoDate: null, raw, unixMs: null };
  }

  return {
    isoDate: plainDate.toString(),
    raw,
    unixMs: plainDate.toZonedDateTime("UTC").epochMilliseconds,
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
  const plainDateTime = parts === null ? null : buildPlainDateTime(parts);
  if (plainDateTime === null) {
    return { isoDateTime: null, raw, unixMs: null };
  }

  const unixMs = buildPragueLocalUnixMs(plainDateTime);
  if (unixMs === null) {
    return { isoDateTime: null, raw, unixMs: null };
  }

  return {
    isoDateTime: plainDateTime.toString({ smallestUnit: "second" }),
    raw,
    unixMs,
  };
};
