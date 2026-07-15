import { createContext, useContext, useMemo } from "react";
import type { PropsWithChildren } from "react";

import { panic } from "better-result";
import { createFormatter } from "use-intl/core";

type Formatter = ReturnType<typeof createFormatter>;

const FormattingLocaleContext = createContext<string | undefined>(undefined);
const FormatterContext = createContext<Formatter | undefined>(undefined);

type FormattingProviderProps = PropsWithChildren<{
  locale: string;
  timeZone: string;
}>;

export const FormattingProvider = ({
  children,
  locale,
  timeZone,
}: FormattingProviderProps) => {
  // The formatter is a context value shared by every formatting hook. Stable
  // identity prevents unrelated consumers from rerendering between locale or
  // time-zone changes.
  const formatter = useMemo(
    () => createFormatter({ locale, timeZone }),
    [locale, timeZone],
  );

  return (
    <FormattingLocaleContext value={locale}>
      <FormatterContext value={formatter}>{children}</FormatterContext>
    </FormattingLocaleContext>
  );
};

export const useFormatter = (): Formatter => {
  const formatter = useContext(FormatterContext);
  if (!formatter) {
    panic("useFormatter must be used within FormattingProvider");
  }
  return formatter;
};

export const useLocale = (): string => {
  const locale = useContext(FormattingLocaleContext);
  if (!locale) {
    panic("useLocale must be used within FormattingProvider");
  }
  return locale;
};
