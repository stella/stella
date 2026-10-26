import { Result } from "better-result";
import * as v from "valibot";

import {
  READER_TEXT_SCALE_DEFAULT,
  READER_TEXT_SCALES,
} from "@stll/decision-reader/reader-text-scale.logic";
import { negotiateAcceptLanguage, UI_LOCALES } from "@stll/locales";
import {
  INSPECTOR_PANE_DEFAULT_WIDTH,
  INSPECTOR_PANE_MAX_WIDTH,
  INSPECTOR_PANE_MIN_WIDTH,
} from "@stll/ui/pane-width";

import { SIDEBAR_STATE_VALUES } from "@/components/sidebar/sidebar-state-cookie";
import {
  decisionTableLayouts,
  StoredDecisionLayoutSchema,
} from "@/features/case-law/decision-column-preferences.logic";
import {
  statuteTableLayouts,
  StoredStatuteLayoutSchema,
} from "@/features/statutes/statute-table-layout.logic";

export const PRESENTATION_PREFS_COOKIE = "stella-presentation";
const MAX_COOKIE_LENGTH = 2048;

/** Legacy sidebar cookie from before the unified presentation preference. */
export const parseLegacySidebarOpen = (
  raw: string | null | undefined,
): boolean | null => {
  switch (raw) {
    case SIDEBAR_STATE_VALUES.expanded:
      return true;
    case SIDEBAR_STATE_VALUES.collapsed:
      return false;
    default:
      return null;
  }
};

export const corePresentationPrefsSchema = v.strictObject({
  readerTextScale: v.fallback(
    v.picklist(READER_TEXT_SCALES),
    READER_TEXT_SCALE_DEFAULT,
  ),
  readerProvisionMode: v.fallback(
    v.picklist(["collapsed", "expanded"]),
    "collapsed",
  ),
  visitorLocale: v.fallback(v.picklist(UI_LOCALES), "en"),
  sidebarOpen: v.fallback(v.boolean(), true),
  theme: v.fallback(v.picklist(["light", "dark", "system"]), "system"),
  palette: v.fallback(v.picklist(["nord", "neutral", "flexoki"]), "neutral"),
  templateDensity: v.fallback(
    v.picklist(["compact", "comfortable"]),
    "compact",
  ),
  inspectorWidth: v.fallback(
    v.pipe(
      v.number(),
      v.integer(),
      v.minValue(INSPECTOR_PANE_MIN_WIDTH),
      v.maxValue(INSPECTOR_PANE_MAX_WIDTH),
    ),
    INSPECTOR_PANE_DEFAULT_WIDTH,
  ),
  region: v.fallback(
    v.pipe(v.string(), v.regex(/^(?:[A-Z]{2}|[0-9]{3})?$/u)),
    "",
  ),
  regionalFormat: v.fallback(v.picklist(["auto", "en-IN"]), "auto"),
  calendar: v.fallback(
    v.picklist(["auto", "gregory", "islamic-umalqura"]),
    "auto",
  ),
  numberingSystem: v.fallback(v.picklist(["auto", "latn", "arab"]), "auto"),
  weekStart: v.fallback(
    v.picklist(["auto", "saturday", "sunday", "monday"]),
    "auto",
  ),
});

export const DECISION_LAYOUT_COOKIE = "stella-decision-layouts";
export const STATUTE_LAYOUT_COOKIE = "stella-statute-layouts";
const MAX_LAYOUT_COOKIE_LENGTH = 3500;

export const decisionLayoutsCookieSchema = v.pipe(
  StoredDecisionLayoutSchema,
  v.transform(decisionTableLayouts),
  v.check(
    (value) =>
      encodeURIComponent(JSON.stringify(value)).length <=
      MAX_LAYOUT_COOKIE_LENGTH,
    "Decision layouts exceed the preference cookie limit",
  ),
);
export const statuteLayoutsCookieSchema = v.pipe(
  StoredStatuteLayoutSchema,
  v.transform(statuteTableLayouts),
  v.check(
    (value) =>
      encodeURIComponent(JSON.stringify(value)).length <=
      MAX_LAYOUT_COOKIE_LENGTH,
    "Statute layouts exceed the preference cookie limit",
  ),
);
export const presentationPrefsSchema = v.strictObject({
  ...corePresentationPrefsSchema.entries,
  decisionLayouts: v.fallback(decisionLayoutsCookieSchema, {}),
  statuteLayouts: v.fallback(statuteLayoutsCookieSchema, {}),
});

export const THEMES = presentationPrefsSchema.entries.theme.options;
export const PALETTES = presentationPrefsSchema.entries.palette.options;

export type PresentationPrefs = v.InferOutput<typeof presentationPrefsSchema>;
export const defaultPresentationPrefs = v.parse(presentationPrefsSchema, {});

/** The cookie is untrusted: malformed objects default, invalid fields default individually. */
export const parsePresentationPrefs = (
  raw: string | undefined,
): PresentationPrefs => {
  if (raw === undefined || raw.length > MAX_COOKIE_LENGTH) {
    return { ...defaultPresentationPrefs };
  }
  const decoded = Result.try((): unknown => JSON.parse(raw));
  if (Result.isError(decoded)) {
    return { ...defaultPresentationPrefs };
  }
  const parsed = v.safeParse(corePresentationPrefsSchema, decoded.value);
  return parsed.success
    ? { ...defaultPresentationPrefs, ...parsed.output }
    : { ...defaultPresentationPrefs };
};

export const parseVisitorPresentationPrefs = (
  raw: string | undefined,
  acceptLanguage: string | undefined,
): PresentationPrefs => {
  const prefs = parsePresentationPrefs(raw);
  if (raw !== undefined) {
    return prefs;
  }
  const { locale, region } = negotiateAcceptLanguage(acceptLanguage);
  return { ...prefs, visitorLocale: locale, region };
};

export const parsePresentationPrefsWithLegacySidebar = ({
  prefsCookie,
  legacySidebarCookie,
  acceptLanguage,
}: {
  prefsCookie: string | undefined;
  legacySidebarCookie: string | undefined;
  acceptLanguage: string | undefined;
}): PresentationPrefs => {
  const prefs = parseVisitorPresentationPrefs(prefsCookie, acceptLanguage);
  if (prefsCookie !== undefined) {
    return prefs;
  }
  const sidebarOpen = parseLegacySidebarOpen(legacySidebarCookie);
  return sidebarOpen === null ? prefs : { ...prefs, sidebarOpen };
};

export const serializePresentationPrefs = ({
  decisionLayouts: _decisions,
  statuteLayouts: _statutes,
  ...prefs
}: PresentationPrefs): string =>
  JSON.stringify(v.parse(corePresentationPrefsSchema, prefs));

type LayoutCookieSchema =
  typeof decisionLayoutsCookieSchema | typeof statuteLayoutsCookieSchema;

export const parseTableLayoutCookie = <TSchema extends LayoutCookieSchema>(
  raw: string | undefined,
  schema: TSchema,
): v.InferOutput<TSchema> | null => {
  if (raw === undefined || raw.length > MAX_LAYOUT_COOKIE_LENGTH) {
    return null;
  }
  const decoded = Result.try((): unknown =>
    encodeURIComponent(raw).length > MAX_LAYOUT_COOKIE_LENGTH
      ? null
      : JSON.parse(raw),
  );
  if (Result.isError(decoded)) {
    return null;
  }
  const parsed = v.safeParse(schema, decoded.value);
  return parsed.success ? parsed.output : null;
};

export const serializeTableLayoutCookie = (
  value: unknown,
  schema: LayoutCookieSchema,
): string => JSON.stringify(v.parse(schema, value));
