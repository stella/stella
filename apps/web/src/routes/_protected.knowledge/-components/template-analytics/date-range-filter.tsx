import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import { DatePickerPopover } from "@stella/ui/components/date-picker-popover";

type DateRangeFilterProps = {
  dateFrom: string;
  dateTo: string;
  onDateFromChange: (value: string) => void;
  onDateToChange: (value: string) => void;
};

const formatDateISO = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

export const getDefaultRange = () => {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
  return {
    dateFrom: formatDateISO(from),
    dateTo: formatDateISO(now),
  };
};

const presets = (t: ReturnType<typeof useTranslations>) => {
  const now = new Date();
  const today = formatDateISO(now);

  return [
    {
      label: t("last7Days"),
      from: formatDateISO(
        new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7),
      ),
      to: today,
    },
    {
      label: t("last30Days"),
      from: formatDateISO(
        new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30),
      ),
      to: today,
    },
    {
      label: t("last90Days"),
      from: formatDateISO(
        new Date(now.getFullYear(), now.getMonth(), now.getDate() - 90),
      ),
      to: today,
    },
  ];
};

export const DateRangeFilter = ({
  dateFrom,
  dateTo,
  onDateFromChange,
  onDateToChange,
}: DateRangeFilterProps) => {
  const t = useTranslations("templateAnalytics");
  const presetOptions = presets(t);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {presetOptions.map((preset) => (
        <Button
          key={preset.label}
          onClick={() => {
            onDateFromChange(preset.from);
            onDateToChange(preset.to);
          }}
          size="sm"
          variant={
            dateFrom === preset.from && dateTo === preset.to
              ? "default"
              : "outline"
          }
        >
          {preset.label}
        </Button>
      ))}
      <div className="flex items-center gap-1">
        <DatePickerPopover
          onChange={(v) => onDateFromChange(v ?? "")}
          value={dateFrom}
        />
        <span className="text-muted-foreground">&ndash;</span>
        <DatePickerPopover
          onChange={(v) => onDateToChange(v ?? "")}
          value={dateTo}
        />
      </div>
    </div>
  );
};
