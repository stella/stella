import { createContext, useContext, useMemo } from "react";
import type { ComponentProps, PropsWithChildren } from "react";

import { panic } from "better-result";
import { createFormatter } from "use-intl/core";

import type { Temporal } from "@stll/time";
import type { Steps } from "@stll/ui/steps";
import { WorkspaceUiFormattingProvider } from "@stll/workspace-ui/formatting";

import type { NumberingPreference } from "@/i18n/i18n-store";
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

  // @stll/workspace-ui cannot read this module's context; its own provider
  // receives the same locale and time zone here.
  return (
    <FormattingLocaleContext value={locale}>
      <FormatterContext value={formatter}>
        <WorkspaceUiFormattingProvider locale={locale} timeZone={timeZone}>
          {children}
        </WorkspaceUiFormattingProvider>
      </FormatterContext>
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

/**
 * The reader's formatting locale for numbers, dates and collation. The UI
 * language that messages render in is `useMessageLocale` from
 * `@/i18n/message-locale`.
 */
export const useFormattingLocale = (): string => {
  const locale = useContext(FormattingLocaleContext);
  if (!locale) {
    panic("useFormattingLocale must be used within FormattingProvider");
  }
  return locale;
};

const STEPS_MARKER_STYLES = {
  latn: "decimal",
  arab: "arabic-indic",
} as const satisfies Record<
  Exclude<NumberingPreference, "auto">,
  ComponentProps<typeof Steps>["markerStyle"]
>;

const isSupportedNumberingSystem = (
  value: string,
): value is keyof typeof STEPS_MARKER_STYLES =>
  Object.hasOwn(STEPS_MARKER_STYLES, value);

export const stepsMarkerStyle = (locale: string) => {
  const system = new Intl.NumberFormat(locale).resolvedOptions()
    .numberingSystem;
  if (!isSupportedNumberingSystem(system)) {
    panic("Steps requires a supported formatting numbering system", { system });
  }
  return STEPS_MARKER_STYLES[system];
};

export const useStepsMarkerStyle = () =>
  stepsMarkerStyle(useFormattingLocale());

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
  const locale = useFormattingLocale();
  return (date) => formatRelativeTimeIn(locale, date);
};
