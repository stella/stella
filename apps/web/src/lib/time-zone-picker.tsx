import { useMemo, useState } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "@stll/ui/combobox";
import { ChevronsUpDownIcon } from "@stll/ui/icons";

import { matchesTimeZone, timeZoneOptions } from "@/lib/time-zone-picker.logic";
import type {
  TimeZoneFollowOption,
  TimeZoneOption,
} from "@/lib/time-zone-picker.logic";
import { jurisdictionTimeZones } from "@/lib/timezones";

const NO_COUNTRIES: readonly string[] = [];

type TimeZonePickerProps = {
  id: string;
  label: string;
  value: string;
  onValueChange: (zone: string) => void;
  disabled?: boolean;
  jurisdictionCountries?: readonly string[];
  follow?: TimeZoneFollowOption;
};

export const TimeZonePicker = ({
  id,
  label,
  value,
  onValueChange,
  disabled,
  jurisdictionCountries = NO_COUNTRIES,
  follow,
}: TimeZonePickerProps) => {
  const t = useTranslations();
  // Offsets follow the moment the list opens, so a page left open across a
  // clock change shows the current ones.
  const [now, setNow] = useState(() => new Date());
  const [browserZone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const items = useMemo(
    () =>
      timeZoneOptions({
        zones: ["UTC", ...Intl.supportedValuesOf("timeZone")],
        browserZone,
        jurisdictionZones: jurisdictionCountries.flatMap(jurisdictionTimeZones),
        selectedZone: value,
        follow,
        now,
      }),
    [browserZone, jurisdictionCountries, value, follow, now],
  );
  const selected =
    items.find((item) => item.value === value) ??
    panic(`Missing selected time zone ${value}`);

  return (
    <Combobox
      disabled={disabled}
      filter={matchesTimeZone}
      items={items}
      itemToStringLabel={(item) => item.label}
      isItemEqualToValue={(item, current) => item.value === current.value}
      value={selected}
      onOpenChange={(open) => {
        if (open) {
          setNow(new Date());
        }
      }}
      onValueChange={(item) => {
        if (item !== null) {
          onValueChange(item.value);
        }
      }}
    >
      <ComboboxTrigger
        aria-label={`${label}: ${selected.label}`}
        id={id}
        variant="field"
      >
        <span className="min-w-0 flex-1 wrap-break-word whitespace-normal">
          {selected.label}
        </span>
        <ChevronsUpDownIcon />
      </ComboboxTrigger>
      <ComboboxPopup>
        <ComboboxInput
          aria-label={t("common.search")}
          placeholder={t("common.search")}
          showTrigger={false}
        />
        <ComboboxList>
          {(item: TimeZoneOption) => (
            <ComboboxItem key={item.value} value={item}>
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0 wrap-break-word whitespace-normal">
                  {item.label}
                </span>
                <span className="text-muted-foreground shrink-0 tabular-nums">
                  {item.offset}
                </span>
              </div>
            </ComboboxItem>
          )}
        </ComboboxList>
        <ComboboxEmpty>{t("common.noResults")}</ComboboxEmpty>
      </ComboboxPopup>
    </Combobox>
  );
};
