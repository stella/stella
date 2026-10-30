/**
 * Subset of IANA timezones covering major population centers.
 * Used for automatic zone detection during sign-in. The searchable
 * picker offers all runtime-supported zones.
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

/**
 * CLDR's country-zone list, supplied by the runtime rather than a second map.
 * Some browsers (Firefox) do not implement `Intl.Locale#getTimeZones`; the
 * jurisdiction zones are only pinned shortcuts, so without it the picker
 * simply shows no jurisdiction pins.
 */
export const jurisdictionTimeZones = (countryCode: string): string[] => {
  const locale = new Intl.Locale(`und-${countryCode}`);
  const getTimeZones: unknown = Reflect.get(locale, "getTimeZones");
  if (typeof getTimeZones !== "function") {
    return [];
  }
  const timeZones = locale.getTimeZones();
  if (timeZones === undefined) {
    return [];
  }
  return timeZones;
};
