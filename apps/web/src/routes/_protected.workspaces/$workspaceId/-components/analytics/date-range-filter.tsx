import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import { Input } from "@stella/ui/components/input";

import { formatDateISO } from "./utils";

type DateRangeFilterProps = {
  dateFrom: string;
  dateTo: string;
  onDateFromChange: (value: string) => void;
  onDateToChange: (value: string) => void;
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
    {
      label: t("thisMonth"),
      from: formatDateISO(new Date(now.getFullYear(), now.getMonth(), 1)),
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
  const t = useTranslations("analytics");
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
        <Input
          className="h-8 w-auto px-2 text-sm"
          onChange={(e) => onDateFromChange(e.currentTarget.value)}
          type="date"
          value={dateFrom}
        />
        <span className="text-muted-foreground">–</span>
        <Input
          className="h-8 w-auto px-2 text-sm"
          onChange={(e) => onDateToChange(e.currentTarget.value)}
          type="date"
          value={dateTo}
        />
      </div>
      {dateFrom > dateTo && (
        <p className="text-destructive text-sm">{t("invalidDateRange")}</p>
      )}
    </div>
  );
};
