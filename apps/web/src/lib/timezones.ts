/**
 * Subset of IANA timezones covering major population centers.
 * Intl.supportedValuesOf("timeZone") returns 400+; this curated
 * list keeps the picker manageable while covering all UTC offsets.
 */
export const COMMON_TIMEZONES = [
  "Pacific/Midway",
  "Pacific/Honolulu",
  "America/Anchorage",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Halifax",
  "America/Sao_Paulo",
  "Atlantic/South_Georgia",
  "Atlantic/Azores",
  "UTC",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Prague",
  "Europe/Bratislava",
  "Europe/Warsaw",
  "Europe/Budapest",
  "Europe/Vilnius",
  "Europe/Riga",
  "Europe/Tallinn",
  "Europe/Helsinki",
  "Europe/Bucharest",
  "Europe/Athens",
  "Europe/Istanbul",
  "Europe/Moscow",
  "Asia/Dubai",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Asia/Dhaka",
  "Asia/Bangkok",
  "Asia/Shanghai",
  "Asia/Hong_Kong",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Australia/Sydney",
  "Pacific/Auckland",
] as const;

export type CommonTimezone = (typeof COMMON_TIMEZONES)[number];
