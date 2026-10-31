import { Result } from "better-result";
import * as v from "valibot";

import { ownerStorageKey } from "@stll/api-contract/browser-storage";
import { CASE_LAW_REGION_BY_JURISDICTION } from "@stll/api-contract/case-law-jurisdictions";
import {
  DECISION_COLUMN_IDS,
  STATUTE_COLUMN_IDS,
  TABLE_CONTENT_MODES,
} from "@stll/api-contract/public-law-table";
import { SEARCH_EXCERPTS } from "@stll/api-contract/search";
import { READER_TEXT_SCALES } from "@stll/decision-reader/reader-text-scale.logic";
import { UI_LOCALES } from "@stll/locales";
import {
  INSPECTOR_PANE_MAX_WIDTH,
  INSPECTOR_PANE_MIN_WIDTH,
} from "@stll/ui/pane-width";

import { DEFAULT_TABLE_COLUMN_MIN_SIZE } from "@/components/workspaces/table/table-column-sizing";
import { legacyBrowserStorage } from "@/lib/account/browser-storage";
import {
  decisionLayoutsCookieSchema,
  defaultPresentationPrefs,
  presentationPrefsSchema,
  statuteLayoutsCookieSchema,
} from "@/lib/account/presentation-prefs/preferences";
import type { PresentationPrefs } from "@/lib/account/presentation-prefs/preferences";
import { READER_PROVISION_MODE_STORAGE_KEY } from "@/lib/account/storage-keys";

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
  [READER_PROVISION_MODE_STORAGE_KEY]: "readerProvisionMode",
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

// The local-storage reader accepted arrays and partial objects under route
// country keys. This decoder exists only while that key is being migrated.
const legacyColumnIds = v.array(v.string());
const legacyPublicLawLayoutSchema = v.object({
  hidden: v.optional(legacyColumnIds),
  order: v.optional(legacyColumnIds),
  pinned: v.optional(legacyColumnIds),
  sizing: v.optional(v.record(v.string(), v.number())),
  contentMode: v.optional(v.picklist(TABLE_CONTENT_MODES)),
});
const legacyDecisionLayoutsSchema = v.record(
  v.string(),
  v.union([
    legacyColumnIds,
    v.object({
      ...legacyPublicLawLayoutSchema.entries,
      excerpt: v.optional(v.picklist(SEARCH_EXCERPTS)),
    }),
  ]),
);
const legacyStatuteLayoutsSchema = v.record(
  v.string(),
  legacyPublicLawLayoutSchema,
);
const partialPresentationPrefsSchema = v.partial(presentationPrefsSchema);
type LegacyDecisionLayout = v.InferOutput<
  typeof legacyDecisionLayoutsSchema
>[string];

const knownColumns = ({
  columns,
  allowed,
}: {
  columns: readonly string[];
  allowed: readonly string[];
}) => [
  ...new Set(columns.filter((column) => allowed.some((id) => id === column))),
];

const legacyPublicCountry = (key: string): string | undefined => {
  const upper = key.toUpperCase();
  return (
    Object.entries(CASE_LAW_REGION_BY_JURISDICTION).find(
      ([country]) => country === upper,
    )?.[0] ??
    Object.entries(CASE_LAW_REGION_BY_JURISDICTION).find(
      ([, region]) => region === upper,
    )?.[0]
  );
};

const normalizeLegacyLayouts = (
  layouts: Readonly<Record<string, LegacyDecisionLayout>>,
  allowedColumns: readonly string[],
) => {
  let retainLegacyKey = false;
  const normalized = new Map<string, unknown>();
  const ordered = Object.entries(layouts).toSorted(([left], [right]) => {
    const leftIsAlias = legacyPublicCountry(left) !== left.toUpperCase();
    const rightIsAlias = legacyPublicCountry(right) !== right.toUpperCase();
    if (leftIsAlias === rightIsAlias) {
      return 0;
    }
    return leftIsAlias ? 1 : -1;
  });
  for (const [key, stored] of ordered) {
    const country = legacyPublicCountry(key);
    if (country === undefined) {
      retainLegacyKey = true;
      continue;
    }
    if (normalized.has(country)) {
      retainLegacyKey = true;
      continue;
    }
    if (Array.isArray(stored)) {
      normalized.set(country, {
        hidden: knownColumns({ columns: stored, allowed: allowedColumns }),
      });
      continue;
    }
    normalized.set(country, {
      ...(stored.hidden === undefined
        ? {}
        : {
            hidden: knownColumns({
              columns: stored.hidden,
              allowed: allowedColumns,
            }),
          }),
      ...(stored.order === undefined
        ? {}
        : {
            order: knownColumns({
              columns: stored.order,
              allowed: allowedColumns,
            }),
          }),
      ...(stored.pinned === undefined
        ? {}
        : {
            pinned: knownColumns({
              columns: stored.pinned,
              allowed: allowedColumns,
            }),
          }),
      ...(stored.sizing === undefined
        ? {}
        : {
            sizing: Object.fromEntries(
              Object.entries(stored.sizing).filter(
                ([column, width]) =>
                  allowedColumns.some((id) => id === column) &&
                  width >= DEFAULT_TABLE_COLUMN_MIN_SIZE &&
                  width <= Number.MAX_SAFE_INTEGER,
              ),
            ),
          }),
      ...(stored.contentMode === undefined
        ? {}
        : { contentMode: stored.contentMode }),
      ...("excerpt" in stored && stored.excerpt !== undefined
        ? { excerpt: stored.excerpt }
        : {}),
    });
  }
  return { normalized: Object.fromEntries(normalized), retainLegacyKey };
};

const readLegacyDecisionLayouts = (raw: string) => {
  const parsed = parseJson(raw, legacyDecisionLayoutsSchema);
  if (parsed?.success !== true) {
    return { kind: "invalid" } as const;
  }
  const { normalized, retainLegacyKey } = normalizeLegacyLayouts(
    parsed.output,
    DECISION_COLUMN_IDS,
  );
  const cookie = v.safeParse(decisionLayoutsCookieSchema, normalized);
  if (!cookie.success) {
    return { kind: "retain" } as const;
  }
  return { kind: "ready", value: cookie.output, retainLegacyKey } as const;
};

const readLegacyStatuteLayouts = (raw: string) => {
  const parsed = parseJson(raw, legacyStatuteLayoutsSchema);
  if (parsed?.success !== true) {
    return { kind: "invalid" } as const;
  }
  const { normalized, retainLegacyKey } = normalizeLegacyLayouts(
    parsed.output,
    STATUTE_COLUMN_IDS,
  );
  const cookie = v.safeParse(statuteLayoutsCookieSchema, normalized);
  if (!cookie.success) {
    return { kind: "retain" } as const;
  }
  return { kind: "ready", value: cookie.output, retainLegacyKey } as const;
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
  localePriority?: "explicit" | "legacy-if-default";
  isCurrentDocument?: () => boolean;
  writePrefs: (patch: Partial<PresentationPrefs>) => Promise<PresentationPrefs>;
  writeProfileLocale: (
    locale: (typeof UI_LOCALES)[number],
  ) => Promise<Result<void, unknown>>;
};

export type LegacyPresentationMigrationResult =
  | { status: "complete"; prefs: PresentationPrefs; locale: string | null }
  | {
      status: "profile-error";
      prefs: PresentationPrefs;
      locale: string | null;
      error: unknown;
    };

const readLegacyLayoutPatch = (
  prefs: PresentationPrefs,
  values: Map<string, string>,
) => {
  const patch: Partial<PresentationPrefs> = {};
  const retainLegacyKeys = new Set<string>();
  const decisionRaw = values.get(LEGACY_KEYS.decisionLayouts);
  if (decisionRaw !== undefined) {
    const decision = readLegacyDecisionLayouts(decisionRaw);
    if (
      decision.kind === "retain" ||
      (decision.kind === "ready" && decision.retainLegacyKey)
    ) {
      retainLegacyKeys.add(LEGACY_KEYS.decisionLayouts);
    }
    if (
      decision.kind === "ready" &&
      Object.keys(prefs.decisionLayouts).length === 0
    ) {
      patch.decisionLayouts = decision.value;
    }
  }
  const statuteRaw = values.get(LEGACY_KEYS.statuteLayouts);
  if (statuteRaw !== undefined) {
    const statute = readLegacyStatuteLayouts(statuteRaw);
    if (
      statute.kind === "retain" ||
      (statute.kind === "ready" && statute.retainLegacyKey)
    ) {
      retainLegacyKeys.add(LEGACY_KEYS.statuteLayouts);
    }
    if (
      statute.kind === "ready" &&
      Object.keys(prefs.statuteLayouts).length === 0
    ) {
      patch.statuteLayouts = statute.value;
    }
  }
  return { patch, retainLegacyKeys };
};

const exactLegacyPatch = (
  parsed: v.InferOutput<typeof partialPresentationPrefsSchema>,
  layoutPatch: Partial<PresentationPrefs>,
): Partial<PresentationPrefs> => {
  const patch: Partial<PresentationPrefs> = {};
  if (parsed.calendar !== undefined) {
    patch.calendar = parsed.calendar;
  }
  if (parsed.numberingSystem !== undefined) {
    patch.numberingSystem = parsed.numberingSystem;
  }
  if (parsed.regionalFormat !== undefined) {
    patch.regionalFormat = parsed.regionalFormat;
  }
  if (parsed.weekStart !== undefined) {
    patch.weekStart = parsed.weekStart;
  }
  if (parsed.theme !== undefined) {
    patch.theme = parsed.theme;
  }
  if (parsed.palette !== undefined) {
    patch.palette = parsed.palette;
  }
  if (parsed.sidebarOpen !== undefined) {
    patch.sidebarOpen = parsed.sidebarOpen;
  }
  if (parsed.readerProvisionMode !== undefined) {
    patch.readerProvisionMode = parsed.readerProvisionMode;
  }
  if (parsed.readerTextScale !== undefined) {
    patch.readerTextScale = parsed.readerTextScale;
  }
  if (parsed.templateDensity !== undefined) {
    patch.templateDensity = parsed.templateDensity;
  }
  if (parsed.inspectorWidth !== undefined) {
    patch.inspectorWidth = parsed.inspectorWidth;
  }
  if (layoutPatch.decisionLayouts !== undefined) {
    patch.decisionLayouts = layoutPatch.decisionLayouts;
  }
  if (layoutPatch.statuteLayouts !== undefined) {
    patch.statuteLayouts = layoutPatch.statuteLayouts;
  }
  return patch;
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
  const parsedWidth =
    widthRaw === undefined
      ? null
      : Result.try((): unknown => JSON.parse(widthRaw));
  const validWidth =
    parsedWidth?.isOk() === true
      ? v.safeParse(
          v.pipe(
            v.number(),
            v.integer(),
            v.minValue(INSPECTOR_PANE_MIN_WIDTH),
            v.maxValue(INSPECTOR_PANE_MAX_WIDTH),
          ),
          parsedWidth.value,
        )
      : null;
  const legacyWidth =
    validWidth?.success === true ? validWidth.output : undefined;
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
  const parsed = v.parse(
    partialPresentationPrefsSchema,
    Object.fromEntries(
      Object.entries(candidate).filter((entry) => entry[1] !== undefined),
    ),
  );
  const layouts = readLegacyLayoutPatch(prefs, values);
  const patch = exactLegacyPatch(parsed, layouts.patch);
  return {
    patch,
    legacyLocale: state?.lang,
    retainLegacyKeys: layouts.retainLegacyKeys,
  };
};

/** Migrates the local-only preferences removed by server first-paint rendering. */
export const migrateLegacyPresentationPreferences = async ({
  prefs,
  profileLocale,
  userId,
  localePriority = "legacy-if-default",
  isCurrentDocument = () => true,
  writePrefs,
  writeProfileLocale,
}: MigrationOptions): Promise<LegacyPresentationMigrationResult> => {
  const provisionKey = ownerStorageKey(
    READER_PROVISION_MODE_STORAGE_KEY,
    userId === null ? { kind: "visitor" } : { kind: "user", userId },
  );
  const keys = [...Object.values(LEGACY_KEYS), provisionKey];
  const values = new Map<string, string>();
  for (const key of keys) {
    const read = legacyBrowserStorage.getItem(key);
    if (read.isErr()) {
      return { status: "complete", prefs, locale: profileLocale };
    }
    if (read.value !== null) {
      values.set(key, read.value);
    }
  }
  if (values.size === 0) {
    return { status: "complete", prefs, locale: profileLocale };
  }
  if (!isCurrentDocument()) {
    return { status: "complete", prefs, locale: profileLocale };
  }

  const { patch, legacyLocale, retainLegacyKeys } = buildLegacyPatch(
    prefs,
    values,
    provisionKey,
  );

  let locale = profileLocale;
  if (legacyLocale !== undefined && localePriority === "legacy-if-default") {
    if (profileLocale === null) {
      const visitorLocale = legacyChoice(
        prefs.visitorLocale,
        defaultPresentationPrefs.visitorLocale,
        legacyLocale,
      );
      if (visitorLocale !== undefined) {
        patch.visitorLocale = visitorLocale;
      }
      locale = visitorLocale ?? prefs.visitorLocale;
    } else if (profileLocale === defaultPresentationPrefs.visitorLocale) {
      const written = await writeProfileLocale(legacyLocale);
      if (written.isErr()) {
        return {
          status: "profile-error",
          prefs,
          locale: profileLocale,
          error: written.error,
        };
      }
      if (!isCurrentDocument()) {
        return { status: "complete", prefs, locale: profileLocale };
      }
      locale = legacyLocale;
    }
  }
  if (!isCurrentDocument()) {
    return { status: "complete", prefs, locale: profileLocale };
  }
  const nextPrefs =
    Object.keys(patch).length === 0 ? prefs : await writePrefs(patch);
  if (!isCurrentDocument()) {
    return { status: "complete", prefs: nextPrefs, locale };
  }
  for (const key of values.keys()) {
    if (retainLegacyKeys.has(key)) {
      continue;
    }
    const removed = legacyBrowserStorage.removeItem(key);
    if (removed.isErr()) {
      break;
    }
  }
  return { status: "complete", prefs: nextPrefs, locale };
};
