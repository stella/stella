import { panic } from "better-result";
import { createTranslator } from "use-intl/core";

import { defaultLocale, locales, localeCodes, type Locale } from "./config";
import ar from "./messages/ar.json";
import cs from "./messages/cs.json";
import de from "./messages/de.json";
import en from "./messages/en.json";
import es from "./messages/es.json";
import et from "./messages/et.json";
import fr from "./messages/fr.json";
import hu from "./messages/hu.json";
import lt from "./messages/lt.json";
import lv from "./messages/lv.json";
import type Messages from "./messages/messages.gen";
import pl from "./messages/pl.json";
import ptBR from "./messages/pt-BR.json";
import sk from "./messages/sk.json";

// Locale catalogs share en's key structure (from messages.gen) with arbitrary
// string values. Mirrors the web app so createTranslator infers the precise
// key union and t("...") keys are type-checked. A drifted catalog also fails
// assignment here, on top of the runtime i18n check.
type LocalizedMessages<T> = {
  [K in keyof T]: T[K] extends string ? string : LocalizedMessages<T[K]>;
};
type LocaleMessages = LocalizedMessages<Messages>;

export const catalogs: Record<Locale, LocaleMessages> = {
  ar,
  cs,
  de,
  en,
  es,
  et,
  fr,
  hu,
  lt,
  lv,
  pl,
  "pt-BR": ptBR,
  sk,
};

// use-intl translator for a locale. Same `use-intl` runtime the web app uses,
// so ICU/plural/interpolation behave identically and the shared i18n check
// validates the same catalog shape across both surfaces. Completeness is
// guaranteed by the i18n-check gate, so no runtime fallback merge is needed.
export const getTranslations = (locale: Locale) =>
  createTranslator({ locale, messages: catalogs[locale] });

// Dot-path key union of the message catalog, derived from the translator so a
// stale key fails typecheck (mirrors apps/web/src/i18n/types.ts). It lives
// beside the translator rather than in `data/site-nav.ts` so data modules can
// reference a catalog key without importing the nav (which imports them back).
export type TranslationKey = Parameters<ReturnType<typeof getTranslations>>[0];

// --- Linked segments inside a translated sentence ---

/**
 * A catalog value split around its `<gh>…</gh>` marker pair. Copy that carries
 * a link inside running prose marks the linked words in every locale, because
 * only the translator knows which words the phrase becomes in their language.
 */
export type LinkedSegment = {
  before: string;
  linked: string;
  after: string;
};

const LINKED_SEGMENT = /^(.*)<gh>(.+?)<\/gh>(.*)$/su;

/**
 * Split a value around its `<gh>…</gh>` markers, or null when it carries none.
 * Callers that require the link throw on null rather than rendering a raw
 * marker to visitors; callers where the link is optional render the plain
 * value.
 */
export const splitLinkedSegment = (value: string): LinkedSegment | null => {
  const match = LINKED_SEGMENT.exec(value);
  if (!match) {
    return null;
  }
  // The pattern's three groups always capture on a match; the outer two may
  // be empty strings, never absent.
  const [, before = "", linked = "", after = ""] = match;
  return { before, linked, after };
};

/**
 * `splitLinkedSegment` for a key whose every catalog must carry the markers:
 * a locale that drops them fails the build instead of shipping `<gh>` to a
 * reader.
 */
export const requireLinkedSegment = (
  key: string,
  value: string,
): LinkedSegment => {
  const segment = splitLinkedSegment(value);
  if (!segment) {
    panic(`${key} must wrap the linked phrase in <gh>…</gh> markers`);
  }
  return segment;
};

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
