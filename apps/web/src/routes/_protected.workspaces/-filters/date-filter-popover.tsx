import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { CheckIcon, XIcon } from "@stll/ui/icons";
import { Separator } from "@stll/ui/separator";
import { cn } from "@stll/ui/utils";

import { DateRangeFilter } from "@/components/date-range-filter";
import type { DateFilter, DateFilterPreset } from "@/lib/workspaces/types";
import { DATE_FILTER_PRESETS } from "@/lib/workspaces/types";

type DateFilterPopoverProps = {
  value: DateFilter | undefined;
  onChange: (value: DateFilter | undefined) => void;
};

export const DateFilterPopover = ({
  value,
  onChange,
}: DateFilterPopoverProps) => {
  const t = useTranslations();
  const labels = useDatePresetLabels();
  const activePreset = value?.preset;
  const isCustom = activePreset === "custom";

  const handlePreset = (preset: DateFilterPreset) => {
    if (preset === activePreset && preset !== "custom") {
      onChange(undefined);
      return;
    }
    onChange({ preset });
  };

  return (
    <div className="flex w-60 flex-col gap-1">
      {DATE_FILTER_PRESETS.map((preset) => {
        const active = preset === activePreset;
        return (
          <button
            className={cn(
              "hover:bg-accent flex items-center justify-between rounded px-2 py-1.5 text-sm",
              active && "text-foreground",
            )}
            key={preset}
            onClick={() => handlePreset(preset)}
            type="button"
          >
            <span>{labels[preset]}</span>
            {active && <CheckIcon className="text-primary size-3.5" />}
          </button>
        );
      })}
      {isCustom && (
        <>
          <Separator className="my-1" />
          <div className="px-1">
            <DateRangeFilter
              from={value?.from ?? null}
              to={value?.to ?? null}
              fromLabel={t("workspaces.filters.from")}
              toLabel={t("workspaces.filters.to")}
              onFromChange={(from) => onChange(buildCustom(from, value?.to))}
              onToChange={(to) => onChange(buildCustom(value?.from, to))}
            />
          </div>
        </>
      )}
      {value && (
        <>
          <Separator className="my-1" />
          <Button onClick={() => onChange(undefined)} size="xs" variant="ghost">
            <XIcon className="size-3.5" />
            {t("workspaces.filters.clear")}
          </Button>
        </>
      )}
    </div>
  );
};

const buildCustom = (
  from: string | null | undefined,
  to: string | null | undefined,
): DateFilter => {
  const result: DateFilter = { preset: "custom" };
  if (from) {
    result.from = from;
  }
  if (to) {
    result.to = to;
  }
  return result;
};

const useDatePresetLabels = (): Record<DateFilterPreset, string> => {
  const t = useTranslations();
  return {
    today: t("common.today"),
    thisWeek: t("workspaces.filters.date.thisWeek"),
    last7d: t("workspaces.filters.date.last7d"),
    last30d: t("workspaces.filters.date.last30d"),
    thisMonth: t("workspaces.filters.date.thisMonth"),
    custom: t("workspaces.filters.date.custom"),
  };
};
