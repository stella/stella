import { useLocale, useTranslations } from "use-intl";

import { DatePickerPopover as UIDatePickerPopover } from "@stll/ui/components/date-picker-popover";
import type { DatePickerPopoverProps } from "@stll/ui/components/date-picker-popover";

const DatePickerPopover = ({
  clearLabel,
  locale,
  placeholderLabel,
  todayLabel,
  ...props
}: DatePickerPopoverProps) => {
  const appLocale = useLocale();
  const t = useTranslations();

  return (
    <UIDatePickerPopover
      {...props}
      clearLabel={clearLabel ?? t("common.clearDate")}
      locale={locale ?? appLocale}
      placeholderLabel={placeholderLabel ?? t("common.selectDate")}
      todayLabel={todayLabel ?? t("common.today")}
    />
  );
};

export { DatePickerPopover };
export type { DatePickerPopoverProps };
