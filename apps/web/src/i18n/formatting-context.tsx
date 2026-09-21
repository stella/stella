import { createContext, useContext, useMemo } from "react";
import type { PropsWithChildren } from "react";

import { panic } from "better-result";
import { createFormatter } from "use-intl/core";

import type { Temporal } from "@stll/time";

import { formatRelativeTimeIn } from "@/lib/relative-time";

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

type RelativeTimeFormat = (date: Date | string | Temporal.Instant) => string;

/**
 * Relative time ("12 hr ago", "yesterday") in the context's locale.
 *
 * A component must not call `formatRelativeTime` from `@/lib/relative-time`
 * directly: it reads the locale from the store, outside React, so the
 * compiler takes it for a pure function of its argument and caches its
 * string. A row rendered under one language then keeps that string after the
 * reader switches to another. The function this returns changes with the
 * locale, so the cache follows it.
 */
export const useRelativeTime = (): RelativeTimeFormat => {
  const locale = useLocale();
  return (date) => formatRelativeTimeIn(locale, date);
};
