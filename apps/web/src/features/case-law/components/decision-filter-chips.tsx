import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";

import { useFormatter } from "@/i18n/formatting-context";

type FacetBucket = { value: string; count: number };

export type DecisionFilterSelection = {
  court: string | undefined;
  year: string | undefined;
};

type DecisionFilterChipsProps = {
  courts: readonly FacetBucket[];
  years: readonly FacetBucket[];
  selection: DecisionFilterSelection;
  onSelectionChange: (selection: DecisionFilterSelection) => void;
};

const ANY = "";

/**
 * Refinement after the fact: the court and year of the decisions on screen,
 * offered once there is something to narrow. A filter never has to be chosen
 * before the first result appears.
 */
export const DecisionFilterChips = ({
  courts,
  onSelectionChange,
  selection,
  years,
}: DecisionFilterChipsProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const active = selection.court !== undefined || selection.year !== undefined;
  if (courts.length === 0 && years.length === 0 && !active) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {(courts.length > 0 || selection.court !== undefined) && (
        <Select
          onValueChange={(value: string | null) =>
            onSelectionChange({
              ...selection,
              court: value === null || value === ANY ? undefined : value,
            })
          }
          value={selection.court ?? ANY}
        >
          <SelectTrigger aria-label={t("common.court")} className="h-8 text-xs">
            <SelectValue placeholder={t("common.court")} />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value={ANY}>{t("common.court")}</SelectItem>
            {courts.map((bucket) => (
              <SelectItem key={bucket.value} value={bucket.value}>
                {bucket.value} ({format.number(bucket.count)})
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      )}
      {(years.length > 0 || selection.year !== undefined) && (
        <Select
          onValueChange={(value: string | null) =>
            onSelectionChange({
              ...selection,
              year: value === null || value === ANY ? undefined : value,
            })
          }
          value={selection.year ?? ANY}
        >
          <SelectTrigger
            aria-label={t("workspaces.views.calendar.year")}
            className="h-8 text-xs"
          >
            <SelectValue placeholder={t("workspaces.views.calendar.year")} />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value={ANY}>
              {t("workspaces.views.calendar.year")}
            </SelectItem>
            {years.map((bucket) => (
              <SelectItem key={bucket.value} value={bucket.value}>
                {bucket.value} ({format.number(bucket.count)})
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      )}
      {active && (
        <Button
          className="text-muted-foreground text-xs"
          onClick={() =>
            onSelectionChange({ court: undefined, year: undefined })
          }
          size="sm"
          type="button"
          variant="ghost"
        >
          {t("workspaces.views.clearFilters")}
        </Button>
      )}
    </div>
  );
};
