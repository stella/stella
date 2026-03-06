import { useCallback } from "react";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";

import { Input } from "@stella/ui/components/input";

import type { DecisionListFilters } from "@/routes/_protected.knowledge/case-law/-queries/decisions";

type DecisionFiltersProps = {
  filters: DecisionListFilters;
  onFiltersChange: (filters: DecisionListFilters) => void;
};

export const DecisionFilters = ({
  filters,
  onFiltersChange,
}: DecisionFiltersProps) => {
  const t = useTranslations();

  const handleSearchChange = useDebouncedCallback((value: string) => {
    onFiltersChange({ ...filters, search: value || undefined });
  }, 300);

  const handleCountryChange = useCallback(
    (value: string) => {
      onFiltersChange({ ...filters, country: value || undefined });
    },
    [filters, onFiltersChange],
  );

  const handleCourtChange = useDebouncedCallback((value: string) => {
    onFiltersChange({ ...filters, court: value || undefined });
  }, 300);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        className="max-w-xs"
        defaultValue={filters.search ?? ""}
        onChange={(e) => handleSearchChange(e.currentTarget.value)}
        placeholder={t("caseLaw.filters.searchPlaceholder")}
      />
      <Input
        className="max-w-32"
        onChange={(e) => handleCountryChange(e.currentTarget.value)}
        placeholder={t("caseLaw.filters.country")}
        value={filters.country ?? ""}
      />
      <Input
        className="max-w-48"
        defaultValue={filters.court ?? ""}
        onChange={(e) => handleCourtChange(e.currentTarget.value)}
        placeholder={t("caseLaw.filters.court")}
      />
      <Input
        className="max-w-40"
        onChange={(e) =>
          onFiltersChange({
            ...filters,
            dateFrom: e.currentTarget.value || undefined,
          })
        }
        placeholder={t("caseLaw.filters.dateFrom")}
        type="date"
        value={filters.dateFrom ?? ""}
      />
      <Input
        className="max-w-40"
        onChange={(e) =>
          onFiltersChange({
            ...filters,
            dateTo: e.currentTarget.value || undefined,
          })
        }
        placeholder={t("caseLaw.filters.dateTo")}
        type="date"
        value={filters.dateTo ?? ""}
      />
    </div>
  );
};
