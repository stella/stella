import { useCallback } from "react";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";

import { Input } from "@stella/ui/components/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stella/ui/components/select";

import type {
  DecisionListFilters,
  SearchFacets,
} from "@/routes/_protected.knowledge/case-law/-queries/decisions";

type DecisionFiltersProps = {
  filters: DecisionListFilters;
  onFiltersChange: (filters: DecisionListFilters) => void;
  facets: SearchFacets;
};

export const DecisionFilters = ({
  filters,
  onFiltersChange,
  facets,
}: DecisionFiltersProps) => {
  const t = useTranslations();

  const handleSearchChange = useDebouncedCallback((value: string) => {
    onFiltersChange({ ...filters, search: value || undefined });
  }, 300);

  const handleCourtSelectChange = useCallback(
    (value: string | null) => {
      onFiltersChange({
        ...filters,
        court: value || undefined,
      });
    },
    [filters, onFiltersChange],
  );

  const handleCourtInputChange = useDebouncedCallback((value: string) => {
    onFiltersChange({
      ...filters,
      court: value || undefined,
    });
  }, 300);

  const handleCountrySelectChange = useCallback(
    (value: string | null) => {
      onFiltersChange({
        ...filters,
        country: value || undefined,
      });
    },
    [filters, onFiltersChange],
  );

  const handleCountryInputChange = useDebouncedCallback((value: string) => {
    onFiltersChange({
      ...filters,
      country: value || undefined,
    });
  }, 300);

  const courtBuckets = facets?.court ?? [];
  const countryBuckets = facets?.country ?? [];

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        className="max-w-xs"
        defaultValue={filters.search ?? ""}
        onChange={(e) => handleSearchChange(e.currentTarget.value)}
        placeholder={t("caseLaw.filters.searchPlaceholder")}
      />

      {countryBuckets.length > 0 ? (
        <Select
          onValueChange={handleCountrySelectChange}
          value={filters.country ?? ""}
        >
          <SelectTrigger className="w-32">
            <SelectValue placeholder={t("caseLaw.filters.country")} />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="">{t("common.all")}</SelectItem>
            {countryBuckets.map((b) => (
              <SelectItem key={b.value} value={b.value}>
                {b.value} ({b.count})
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : (
        <Input
          className="max-w-32"
          defaultValue={filters.country ?? ""}
          onChange={(e) => handleCountryInputChange(e.currentTarget.value)}
          placeholder={t("caseLaw.filters.country")}
        />
      )}

      {courtBuckets.length > 0 ? (
        <Select
          onValueChange={handleCourtSelectChange}
          value={filters.court ?? ""}
        >
          <SelectTrigger className="w-56">
            <SelectValue placeholder={t("caseLaw.filters.court")} />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="">{t("common.all")}</SelectItem>
            {courtBuckets.map((b) => (
              <SelectItem key={b.value} value={b.value}>
                {b.value} ({b.count})
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : (
        <Input
          className="max-w-48"
          defaultValue={filters.court ?? ""}
          onChange={(e) => handleCourtInputChange(e.currentTarget.value)}
          placeholder={t("caseLaw.filters.court")}
        />
      )}

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
