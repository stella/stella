import { createContext, useContext, useMemo } from "react";
import type { PropsWithChildren } from "react";

import { panic } from "better-result";
import { createFormatter } from "use-intl/core";

type Formatter = ReturnType<typeof createFormatter>;

type Formatting = {
  formatter: Formatter;
  locale: string;
};

const FormattingContext = createContext<Formatting | undefined>(undefined);

export type WorkspaceUiFormattingProviderProps = PropsWithChildren<{
  /**
   * The reader's formatting locale (region, calendar, numbering system and
   * week start as `-u-` extensions), which may differ from the UI language
   * the host's `IntlProvider` serves messages in.
   */
  locale: string;
  timeZone: string;
}>;

/**
 * Supplies the locale this package formats numbers, money and dates in.
 * Components that format read it here rather than from `use-intl`, whose
 * locale is the UI language.
 */
export const WorkspaceUiFormattingProvider = ({
  children,
  locale,
  timeZone,
}: WorkspaceUiFormattingProviderProps) => {
  const formatting = useMemo(
    () => ({ formatter: createFormatter({ locale, timeZone }), locale }),
    [locale, timeZone],
  );

  return <FormattingContext value={formatting}>{children}</FormattingContext>;
};

const useFormatting = (): Formatting => {
  const formatting = useContext(FormattingContext);
  if (!formatting) {
    panic(
      "@stll/workspace-ui formats numbers and dates in the host's formatting locale; render this component inside WorkspaceUiFormattingProvider",
    );
  }
  return formatting;
};

export const useFormatter = (): Formatter => useFormatting().formatter;

export const useFormattingLocale = (): string => useFormatting().locale;
