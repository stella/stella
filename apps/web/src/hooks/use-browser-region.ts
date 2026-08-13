import { useSyncExternalStore } from "react";

const noopSubscribe = (_onStoreChange: () => void) => () => undefined;

export const regionFromLocale = (locale: string | undefined): string => {
  if (!locale) {
    return "";
  }
  try {
    return new Intl.Locale(locale.replace("_", "-")).region ?? "";
  } catch {
    return "";
  }
};

const getBrowserRegion = (): string =>
  regionFromLocale(navigator.languages.at(0) ?? navigator.language);

export const useBrowserRegion = (): string =>
  useSyncExternalStore(noopSubscribe, getBrowserRegion, () => "");
