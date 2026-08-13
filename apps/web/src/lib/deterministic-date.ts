const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/u;

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
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
};
