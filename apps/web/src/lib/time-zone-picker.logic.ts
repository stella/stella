import { Temporal } from "@stll/time";

import { matchesComboboxItem } from "@/components/combobox-filter.logic";

export type TimeZoneOption = {
  value: string;
  label: string;
  offset: string;
};

export type TimeZoneFollowOption = {
  value: string;
  label: string;
  zone: string;
};

type TimeZoneOptionsParams = {
  zones: readonly string[];
  browserZone: string;
  jurisdictionZones: readonly string[];
  selectedZone: string;
  follow?: TimeZoneFollowOption | undefined;
  now: Date;
};

/** Offsets use the supplied instant, including the zone's current DST rules. */
const timeZoneOffset = (zone: string, now: Date): string =>
  `UTC${Temporal.Instant.fromEpochMilliseconds(now.getTime()).toZonedDateTimeISO(zone).offset}`;

export const timeZoneOptions = ({
  zones,
  browserZone,
  jurisdictionZones,
  selectedZone,
  follow,
  now,
}: TimeZoneOptionsParams): TimeZoneOption[] => {
  const ordered = new Set([
    browserZone,
    ...jurisdictionZones,
    ...zones,
    ...(follow?.value === selectedZone ? [] : [selectedZone]),
  ]);
  const options = Array.from(ordered, (zone) => ({
    value: zone,
    label: zone.replace(/_/gu, " "),
    offset: timeZoneOffset(zone, now),
  }));
  return follow === undefined
    ? options
    : [
        {
          value: follow.value,
          label: follow.label,
          offset: timeZoneOffset(follow.zone, now),
        },
        ...options,
      ];
};

export const matchesTimeZone = (item: TimeZoneOption, query: string): boolean =>
  matchesComboboxItem(
    item,
    query,
    (zone) => `${zone.value} ${zone.label} ${zone.offset}`,
  );
