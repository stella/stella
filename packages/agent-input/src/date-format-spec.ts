/**
 * How a date field renders: a locale and a style.
 *
 * The same pair reaches the engine two ways — as one string in a marker's
 * `date("pl-long")` filter, and as a `{ locale, style }` object on the tool
 * wire — so both are read here and both produce the canonical pair. A locale
 * carries its own hyphens (`en-GB`, `pt-BR`), so only a final segment that
 * names a style is one, and the style test runs first: `date("iso")` names a
 * style, not a three-letter language tag. A bare style asks for the locale it
 * is missing, except `iso`, whose output has none.
 */

import { DATE_FORMAT_STYLES } from "@stll/template-conditions";
import type { DateFormatStyle } from "@stll/template-conditions";

import { normalizeEnumValue } from "./enum-value";
import { normalizeLocale } from "./locale";
import type { Normalized, NormalizedAsk } from "./normalized";
import { askForFix, readValueAs } from "./normalized";

export type DateFormatSpec = {
  locale: string;
  style: DateFormatStyle;
};

/** Narrow `unknown` to a plain object (not null, not array). */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What a spec means when it names only a locale. */
const DEFAULT_DATE_FORMAT_STYLE = "long" as const satisfies DateFormatStyle;

const quoted = (values: readonly string[]): string =>
  values.map((value) => `"${value}"`).join(", ");

const DATE_FORMAT_SPEC_EXPECTED = "a locale with an optional style";
export const DATE_FORMAT_SPEC_HINT =
  'Write the BCP-47 locale, optionally suffixed with a style: "pl", ' +
  '"cs-CZ", "pl-long", "en-GB-short". The styles are ' +
  `${quoted(DATE_FORMAT_STYLES)} and the default is ` +
  `"${DEFAULT_DATE_FORMAT_STYLE}"; "iso" stands alone, since an ISO date ` +
  "reads the same in every language.";

/**
 * Style names a model reaches for that are not the catalogue's own. `full` is
 * `Intl`'s longest date style and `numeric` its all-digit one, so each names
 * exactly one of ours.
 */
const STYLE_SYNONYMS: ReadonlyMap<string, DateFormatStyle> = new Map([
  ["full", "long"],
  ["numeric", "short"],
]);

const readStyle = (input: unknown): Normalized<DateFormatStyle> => {
  const synonym =
    typeof input === "string"
      ? STYLE_SYNONYMS.get(input.trim().toLowerCase())
      : undefined;
  return normalizeEnumValue(synonym ?? input, DATE_FORMAT_STYLES, {
    label: "The styles",
    expected: "a date style",
  });
};

const specAsk = (input: unknown): NormalizedAsk =>
  askForFix({
    input,
    expected: DATE_FORMAT_SPEC_EXPECTED,
    hint: DATE_FORMAT_SPEC_HINT,
  });

/** Split a spec into the locale text and the style it names, if any. Only a
 *  final segment that reads as a style is one; everything else is the tag. */
const splitSpec = (
  spec: string,
): { localeText: string; style: DateFormatStyle | null } => {
  const cut = Math.max(spec.lastIndexOf("-"), spec.lastIndexOf("_"));
  if (cut <= 0) {
    return { localeText: spec, style: null };
  }
  const tail = readStyle(spec.slice(cut + 1));
  return tail.ok
    ? { localeText: spec.slice(0, cut), style: tail.value }
    : { localeText: spec, style: null };
};

/**
 * The one style whose output names no language: `2028-06-13` is the same
 * string in every locale, so `iso` on its own is a complete format. The pair
 * still carries a locale because the rendering shape has one, and `en` is the
 * carrier that never reaches a rendered date.
 */
const LOCALE_FREE_STYLE = "iso" as const satisfies DateFormatStyle;
const LOCALE_FREE_STYLE_LOCALE = "en";

/** `pl-long`, `cs`, `en-GB`, `cs_CZ`, `en-GB-short`, `pl-full`, `iso`. */
const readStringSpec = (input: string): Normalized<DateFormatSpec> => {
  const spec = input.trim();
  if (spec === "") {
    return specAsk(input);
  }
  const bare = readStyle(spec);
  if (bare.ok) {
    // Every other bare style configures no locale, so it is an ask rather
    // than a tag: a date in an unknown language is a wrong date.
    return bare.value === LOCALE_FREE_STYLE
      ? readValueAs(
          input,
          { locale: LOCALE_FREE_STYLE_LOCALE, style: bare.value },
          `"${LOCALE_FREE_STYLE}"`,
        )
      : specAsk(input);
  }
  const { localeText, style } = splitSpec(spec);
  const locale = normalizeLocale(localeText);
  if (!locale.ok) {
    return specAsk(input);
  }
  const value = {
    locale: locale.value,
    style: style ?? DEFAULT_DATE_FORMAT_STYLE,
  };
  return readValueAs(
    input,
    value,
    style === null ? `"${value.locale}"` : `"${value.locale}-${value.style}"`,
  );
};

const SPEC_KEYS = ["locale", "style"] as const;

const entryFor = (
  entries: readonly (readonly [string, unknown])[],
  name: (typeof SPEC_KEYS)[number],
): unknown => entries.find(([key]) => key.toLowerCase() === name)?.[1];

/** `{ locale, style }` with either key casing, and `style` optional. */
const readObjectSpec = (
  input: Record<string, unknown>,
): Normalized<DateFormatSpec> => {
  const entries = Object.entries(input);
  const unknown = entries.filter(
    ([key]) => !SPEC_KEYS.some((name) => name === key.toLowerCase()),
  );
  if (unknown.length > 0) {
    return askForFix({
      input,
      expected: DATE_FORMAT_SPEC_EXPECTED,
      hint: `A date format carries ${quoted([...SPEC_KEYS])} and nothing else. ${DATE_FORMAT_SPEC_HINT}`,
    });
  }
  const rawLocale = entryFor(entries, "locale");
  if (rawLocale === undefined || rawLocale === null) {
    return specAsk(input);
  }
  const locale = normalizeLocale(rawLocale);
  if (!locale.ok) {
    return locale;
  }
  const rawStyle = entryFor(entries, "style");
  if (rawStyle === undefined || rawStyle === null) {
    return readValueAs(input, {
      locale: locale.value,
      style: DEFAULT_DATE_FORMAT_STYLE,
    });
  }
  const style = readStyle(rawStyle);
  if (!style.ok) {
    return style;
  }
  return readValueAs(input, { locale: locale.value, style: style.value });
};

/** Read a date-format spec an agent spelled its own way, as one string or as
 *  the wire object. */
export const normalizeDateFormatSpec = (
  input: unknown,
): Normalized<DateFormatSpec> => {
  if (typeof input === "string") {
    return readStringSpec(input);
  }
  if (isRecord(input)) {
    return readObjectSpec(input);
  }
  return specAsk(input);
};
