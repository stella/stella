import { useTranslations } from "use-intl";

import {
  DateRangeFilter as UIDateRangeFilter,
  type DateRangeFilterProps as UIDateRangeFilterProps,
} from "@stll/ui/date-range-filter";

import { getPickerToday } from "@/components/date-picker-popover";
import { useLocale } from "@/i18n/formatting-context";

type DateRangeFilterProps = Omit<
  UIDateRangeFilterProps,
  "fromLabel" | "toLabel"
> & {
  fromLabel?: string;
  toLabel?: string;
};

export const DateRangeFilter = ({
  fromLabel,
  toLabel,
  locale,
  ...props
}: DateRangeFilterProps) => {
  const t = useTranslations();
  const appLocale = useLocale();
  return (
    <UIDateRangeFilter
      {...props}
      getToday={getPickerToday}
      fromLabel={fromLabel ?? t("search.dateFrom")}
      toLabel={toLabel ?? t("search.dateTo")}
      locale={locale ?? appLocale}
      clearLabel={t("common.clearDate")}
      dialogLabel={t("common.datePicker.label")}
      nextDecadeLabel={t("common.datePicker.nextDecade")}
      nextMonthLabel={t("common.datePicker.nextMonth")}
      nextYearLabel={t("common.datePicker.nextYear")}
      placeholderLabel={t("common.selectDate")}
      previousDecadeLabel={t("common.datePicker.previousDecade")}
      previousMonthLabel={t("common.datePicker.previousMonth")}
      previousYearLabel={t("common.datePicker.previousYear")}
      todayLabel={t("common.today")}
      outOfRangeLabel={t("common.datePicker.outOfRange")}
    />
  );
};
