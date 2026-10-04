import { useTranslations } from "use-intl";

import { DatePickerPopover as UIDatePickerPopover } from "@stll/ui/date-picker-popover";
import type { DatePickerPopoverProps } from "@stll/ui/date-picker-popover";

import { useLocale } from "@/i18n/formatting-context";

const DatePickerPopover = ({
  clearLabel,
  dialogLabel,
  locale,
  nextDecadeLabel,
  nextMonthLabel,
  nextYearLabel,
  placeholderLabel,
  previousDecadeLabel,
  previousMonthLabel,
  previousYearLabel,
  timeLabel,
  todayLabel,
  ...props
}: DatePickerPopoverProps) => {
  const appLocale = useLocale();
  const t = useTranslations();

  return (
    <UIDatePickerPopover
      {...props}
      clearLabel={clearLabel ?? t("common.clearDate")}
      dialogLabel={dialogLabel ?? t("common.datePicker.label")}
      locale={locale ?? appLocale}
      nextDecadeLabel={nextDecadeLabel ?? t("common.datePicker.nextDecade")}
      nextMonthLabel={nextMonthLabel ?? t("common.datePicker.nextMonth")}
      nextYearLabel={nextYearLabel ?? t("common.datePicker.nextYear")}
      placeholderLabel={placeholderLabel ?? t("common.selectDate")}
      previousDecadeLabel={
        previousDecadeLabel ?? t("common.datePicker.previousDecade")
      }
      previousMonthLabel={
        previousMonthLabel ?? t("common.datePicker.previousMonth")
      }
      previousYearLabel={
        previousYearLabel ?? t("common.datePicker.previousYear")
      }
      timeLabel={timeLabel ?? t("common.datePicker.time")}
      todayLabel={todayLabel ?? t("common.today")}
    />
  );
};

export { DatePickerPopover };
export type { DatePickerPopoverProps };
