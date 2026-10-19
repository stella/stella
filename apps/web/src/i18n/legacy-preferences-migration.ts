import { Result } from "better-result";
import * as v from "valibot";

import { ownerStorageKey } from "@stll/api-contract/browser-storage";
import { READER_TEXT_SCALES } from "@stll/decision-reader/reader-text-scale.logic";
import { UI_LOCALES } from "@stll/locales";

import { legacyBrowserStorage } from "@/lib/account/browser-storage";
import {
  defaultPresentationPrefs,
  decisionLayoutsCookieSchema,
  presentationPrefsSchema,
  statuteLayoutsCookieSchema,
} from "@/lib/account/presentation-prefs/preferences";
import type { PresentationPrefs } from "@/lib/account/presentation-prefs/preferences";

const LEGACY_KEYS = {
  i18n: "stella-i18n",
  theme: "stella-ui-theme",
  palette: "stella-ui-palette",
  sidebarOpen: "sidebar_state",
  readerTextScale: "reader_text_scale",
  templateDensity: "stella.templates.density",
  inspectorWidth: "stella:inspector-pane-width:v2",
  inspectorMatterWidth: "stella:inspector-pane-width:v1:matter",
  inspectorPublicLawWidth: "stella:inspector-pane-width:v1:public-law",
  decisionLayouts: "case_law_hidden_columns",
  statuteLayouts: "statute_table_layout",
} as const;

export const LEGACY_PRESENTATION_PREFERENCE_TABLE = {
  [LEGACY_KEYS.i18n]:
    "visitorLocale, calendar, numberingSystem, regionalFormat, weekStart",
  [LEGACY_KEYS.theme]: "theme",
  [LEGACY_KEYS.palette]: "palette",
  [LEGACY_KEYS.sidebarOpen]: "sidebarOpen",
  reader_provision_mode: "readerProvisionMode",
  [LEGACY_KEYS.readerTextScale]: "readerTextScale",
  [LEGACY_KEYS.templateDensity]: "templateDensity",
  [LEGACY_KEYS.inspectorWidth]: "inspectorWidth",
  [LEGACY_KEYS.inspectorMatterWidth]: "inspectorWidth",
  [LEGACY_KEYS.inspectorPublicLawWidth]: "inspectorWidth",
  [LEGACY_KEYS.decisionLayouts]: "decisionLayouts",
  [LEGACY_KEYS.statuteLayouts]: "statuteLayouts",
} as const;

const i18nSchema = v.object({
  state: v.object({
    lang: v.optional(v.picklist(UI_LOCALES)),
    calendar: v.optional(v.picklist(["auto", "gregory", "islamic-umalqura"])),
    numberingSystem: v.optional(v.picklist(["auto", "latn", "arab"])),
    regionalFormat: v.optional(v.picklist(["auto", "en-IN"])),
    weekStart: v.optional(v.picklist(["auto", "saturday", "sunday", "monday"])),
  }),
});

const parseJson = <TSchema extends v.GenericSchema>(
  raw: string,
  schema: TSchema,
) => {
  const decoded = Result.try((): unknown => JSON.parse(raw));
  return decoded.isOk() ? v.safeParse(schema, decoded.value) : null;
};

const legacyChoice = <T>(current: T, fallback: T, legacy: T | undefined) =>
  legacy !== undefined && current === fallback ? legacy : undefined;

const pickStored = <T extends string>(
  values: Map<string, string>,
  key: string,
  choices: readonly T[],
): T | undefined => {
  const value = values.get(key);
  return choices.find((choice) => choice === value);
};

type MigrationOptions = {
  prefs: PresentationPrefs;
  profileLocale: (typeof UI_LOCALES)[number] | null;
  userId: string | null;
  writePrefs: (patch: Partial<PresentationPrefs>) => Promise<PresentationPrefs>;
  writeProfileLocale: (locale: (typeof UI_LOCALES)[number]) => Promise<void>;
};

const buildLegacyPatch = (
  prefs: PresentationPrefs,
  values: Map<string, string>,
  provisionKey: string,
) => {
  const i18nRaw = values.get(LEGACY_KEYS.i18n);
  const i18n = i18nRaw === undefined ? null : parseJson(i18nRaw, i18nSchema);
  const state = i18n?.success === true ? i18n.output.state : undefined;
  const sidebarRaw = values.get(LEGACY_KEYS.sidebarOpen);
  let legacySidebar: boolean | undefined;
  if (sidebarRaw === "expanded") {
    legacySidebar = true;
  }
  if (sidebarRaw === "collapsed") {
    legacySidebar = false;
  }
  const provision = Result.try((): unknown =>
    JSON.parse(values.get(provisionKey) ?? ""),
  );
  const legacyProvision =
    provision.isOk() &&
    (provision.value === "collapsed" || provision.value === "expanded")
      ? provision.value
      : undefined;
  const scale = Result.try((): unknown =>
    JSON.parse(values.get(LEGACY_KEYS.readerTextScale) ?? ""),
  );
  const parsedScale = scale.isOk()
    ? v.safeParse(v.picklist(READER_TEXT_SCALES), scale.value)
    : null;
  const widthRaw = [
    LEGACY_KEYS.inspectorWidth,
    LEGACY_KEYS.inspectorMatterWidth,
    LEGACY_KEYS.inspectorPublicLawWidth,
  ]
    .map((key) => values.get(key))
    .find((value) => value !== undefined);
  const width = widthRaw === undefined ? undefined : Number(widthRaw);
  const legacyWidth =
    width !== undefined &&
    Number.isInteger(width) &&
    width >= 320 &&
    width <= 1400
      ? width
      : undefined;
  const candidate: Record<string, unknown> = {
    calendar: legacyChoice(
      prefs.calendar,
      defaultPresentationPrefs.calendar,
      state?.calendar,
    ),
    numberingSystem: legacyChoice(
      prefs.numberingSystem,
      defaultPresentationPrefs.numberingSystem,
      state?.numberingSystem,
    ),
    regionalFormat: legacyChoice(
      prefs.regionalFormat,
      defaultPresentationPrefs.regionalFormat,
      state?.regionalFormat,
    ),
    weekStart: legacyChoice(
      prefs.weekStart,
      defaultPresentationPrefs.weekStart,
      state?.weekStart,
    ),
    theme: legacyChoice(
      prefs.theme,
      defaultPresentationPrefs.theme,
      pickStored(values, LEGACY_KEYS.theme, ["light", "dark", "system"]),
    ),
    palette: legacyChoice(
      prefs.palette,
      defaultPresentationPrefs.palette,
      pickStored(values, LEGACY_KEYS.palette, ["nord", "neutral", "flexoki"]),
    ),
    sidebarOpen: legacyChoice(
      prefs.sidebarOpen,
      defaultPresentationPrefs.sidebarOpen,
      legacySidebar,
    ),
    readerProvisionMode: legacyChoice(
      prefs.readerProvisionMode,
      defaultPresentationPrefs.readerProvisionMode,
      legacyProvision,
    ),
    readerTextScale: legacyChoice(
      prefs.readerTextScale,
      defaultPresentationPrefs.readerTextScale,
      parsedScale?.success === true ? parsedScale.output : undefined,
    ),
    templateDensity: legacyChoice(
      prefs.templateDensity,
      defaultPresentationPrefs.templateDensity,
      pickStored(values, LEGACY_KEYS.templateDensity, [
        "compact",
        "comfortable",
      ]),
    ),
    inspectorWidth: legacyChoice(
      prefs.inspectorWidth,
      defaultPresentationPrefs.inspectorWidth,
      legacyWidth,
    ),
  };
  const patch = v.parse(
    v.partial(presentationPrefsSchema),
    Object.fromEntries(
      Object.entries(candidate).filter((entry) => entry[1] !== undefined),
    ),
  );
  for (const [legacyKey, preference, schema] of [
    [
      LEGACY_KEYS.decisionLayouts,
      "decisionLayouts",
      decisionLayoutsCookieSchema,
    ],
    [LEGACY_KEYS.statuteLayouts, "statuteLayouts", statuteLayoutsCookieSchema],
  ] as const) {
    const raw = values.get(legacyKey);
    const parsed = raw === undefined ? null : parseJson(raw, schema);
    if (
      parsed?.success === true &&
      Object.keys(prefs[preference]).length === 0
    ) {
      Object.assign(patch, { [preference]: parsed.output });
    }
  }
  return { patch, legacyLocale: state?.lang };
};

/** Migrates the local-only preferences removed by server first-paint rendering. */
export const migrateLegacyPresentationPreferences = async ({
  prefs,
  profileLocale,
  userId,
  writePrefs,
  writeProfileLocale,
}: MigrationOptions): Promise<{
  prefs: PresentationPrefs;
  locale: string | null;
}> => {
  const provisionKey = ownerStorageKey(
    "reader_provision_mode",
    userId === null ? { kind: "visitor" } : { kind: "user", userId },
  );
  const keys = [...Object.values(LEGACY_KEYS), provisionKey];
  const values = new Map<string, string>();
  for (const key of keys) {
    const read = legacyBrowserStorage.getItem(key);
    if (read.isErr()) {
      return { prefs, locale: profileLocale };
    }
    if (read.value !== null) {
      values.set(key, read.value);
    }
  }
  if (values.size === 0) {
    return { prefs, locale: profileLocale };
  }

  const { patch, legacyLocale } = buildLegacyPatch(prefs, values, provisionKey);

  let locale = profileLocale;
  if (legacyLocale !== undefined) {
    if (profileLocale === null) {
      patch.visitorLocale = legacyChoice(
        prefs.visitorLocale,
        defaultPresentationPrefs.visitorLocale,
        legacyLocale,
      );
      locale = patch.visitorLocale ?? prefs.visitorLocale;
    } else if (profileLocale === defaultPresentationPrefs.visitorLocale) {
      await writeProfileLocale(legacyLocale);
      locale = legacyLocale;
    }
  }
  const nextPrefs =
    Object.keys(patch).length === 0 ? prefs : await writePrefs(patch);
  for (const key of values.keys()) {
    const removed = legacyBrowserStorage.removeItem(key);
    if (removed.isErr()) {
      break;
    }
  }
  return { prefs: nextPrefs, locale };
};
