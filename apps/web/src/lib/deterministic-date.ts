const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/u;
const DAYS_PER_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const hasValidCalendarDate = (value: string): boolean => {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }
  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth =
    month === 2 && isLeapYear ? 29 : DAYS_PER_MONTH.at(month - 1);
  return daysInMonth !== undefined && day <= daysInMonth;
};

/**
 * Parse a serialized calendar date or explicitly zoned ISO instant without
 * consulting the host time zone. Time-zone-less datetime strings are rejected.
 */
export const parseDeterministicDate = (value: Date | string): Date | null => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  let normalized: string | null = null;
  if (ISO_DATE_PATTERN.test(value)) {
    normalized = `${value}T00:00:00Z`;
  } else if (ISO_INSTANT_PATTERN.test(value)) {
    normalized = value;
  }
  if (normalized === null) {
    return null;
  }
  if (!hasValidCalendarDate(value)) {
    return null;
  }
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
};
