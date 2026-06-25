import { createTranslator } from "use-intl/core";

import { defaultLocale, locales, localeCodes, type Locale } from "./config";
import en from "./messages/en.json";
import es from "./messages/es.json";
import type Messages from "./messages/messages.gen";
import ptBR from "./messages/pt-BR.json";

// Locale catalogs share en's key structure (from messages.gen) with arbitrary
// string values. Mirrors the web app so createTranslator infers the precise
// key union and t("...") keys are type-checked. A drifted catalog also fails
// assignment here, on top of the runtime i18n check.
type LocalizedMessages<T> = {
  [K in keyof T]: T[K] extends string ? string : LocalizedMessages<T[K]>;
};
type LocaleMessages = LocalizedMessages<Messages>;

const catalogs: Record<Locale, LocaleMessages> = {
  en,
  es,
  "pt-BR": ptBR,
};

// use-intl translator for a locale. Same `use-intl` runtime the web app uses,
// so ICU/plural/interpolation behave identically and the shared i18n check
// validates the same catalog shape across both surfaces. Completeness is
// guaranteed by the i18n-check gate, so no runtime fallback merge is needed.
export const getTranslations = (locale: Locale) =>
  createTranslator({ locale, messages: catalogs[locale] });

// --- URL helpers (locale routing + multilingual SEO) ---

// Prefix a root-relative path with the locale segment ("" for the default).
export const localizePath = (path: string, locale: Locale): string => {
  const segment = locales[locale].path;
  const clean = path.startsWith("/") ? path : `/${path}`;
  if (!segment) {
    return clean;
  }
  return clean === "/" ? `/${segment}/` : `/${segment}${clean}`;
};

// Resolve the active locale from a URL pathname (first segment).
export const localeFromPath = (pathname: string): Locale => {
  const first = pathname.split("/").find((segment) => segment.length > 0);
  if (!first) {
    return defaultLocale;
  }
  for (const code of localeCodes) {
    if (locales[code].path && locales[code].path === first) {
      return code;
    }
  }
  return defaultLocale;
};

// Strip the locale prefix from a pathname, returning the canonical en path.
export const stripLocale = (pathname: string): string => {
  const locale = localeFromPath(pathname);
  const segment = locales[locale].path;
  if (!segment) {
    return pathname || "/";
  }
  const stripped = pathname.replace(new RegExp(`^/${segment}(?=/|$)`, "u"), "");
  return stripped === "" ? "/" : stripped;
};

export type Alternate = { hreflang: string; href: string };

// hreflang alternates for a page: one per locale plus x-default (the default
// locale). `basePath` is the locale-independent path (e.g. "/", "/security").
export const getAlternates = (basePath: string, site: URL): Alternate[] => {
  const alternates: Alternate[] = localeCodes.map((code) => ({
    hreflang: locales[code].hreflang,
    href: new URL(localizePath(basePath, code), site).href,
  }));
  alternates.push({
    hreflang: "x-default",
    href: new URL(localizePath(basePath, defaultLocale), site).href,
  });
  return alternates;
};
