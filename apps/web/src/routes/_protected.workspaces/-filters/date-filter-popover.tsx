import { CheckIcon, XIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Separator } from "@stll/ui/components/separator";
import { cn } from "@stll/ui/lib/utils";

import { DatePickerPopover } from "@/components/date-picker-popover";
import type {
  DateFilter,
  DateFilterPreset,
} from "@/routes/_protected.workspaces/-types";
import { DATE_FILTER_PRESETS } from "@/routes/_protected.workspaces/-types";

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
          <div className="flex flex-col gap-2 px-1">
            <div className="flex flex-col gap-1">
              <span className="text-muted-foreground text-xs">
                {t("workspaces.filters.from")}
              </span>
              <DatePickerPopover
                onChange={(v) => onChange(buildCustom(v, value?.to))}
                value={value?.from ?? null}
                {...(value?.to && { maxDate: value.to })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-muted-foreground text-xs">
                {t("workspaces.filters.to")}
              </span>
              <DatePickerPopover
                onChange={(v) => onChange(buildCustom(value?.from, v))}
                value={value?.to ?? null}
                {...(value?.from && { minDate: value.from })}
              />
            </div>
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
    today: t("workspaces.filters.date.today"),
    thisWeek: t("workspaces.filters.date.thisWeek"),
    last7d: t("workspaces.filters.date.last7d"),
    last30d: t("workspaces.filters.date.last30d"),
    thisMonth: t("workspaces.filters.date.thisMonth"),
    custom: t("workspaces.filters.date.custom"),
  };
};
