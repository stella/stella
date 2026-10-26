import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { Result } from "better-result";
import { afterAll, afterEach, expect, test } from "bun:test";

import { PUBLIC_COUNTRIES } from "@stll/api-contract/public-country-capability";
import {
  DECISION_COLUMN_IDS,
  STATUTE_COLUMN_IDS,
} from "@stll/api-contract/public-law-table";
import { UI_LOCALES } from "@stll/locales";
import { rejectionOf } from "@stll/property-testing/rejection";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/" });

const { legacyBrowserStorage } = await import("@/lib/account/browser-storage");
const { seedLegacyBrowserStorage } =
  await import("@/lib/account/browser-storage.test-fixtures");
const { defaultPresentationPrefs } =
  await import("@/lib/account/presentation-prefs/preferences");
const { DEFAULT_DECISION_TABLE_LAYOUT } =
  await import("@/features/case-law/decision-column-preferences.logic");
const { DEFAULT_STATUTE_TABLE_LAYOUT } =
  await import("@/features/statutes/statute-table-layout.logic");
const {
  LEGACY_PRESENTATION_PREFERENCE_TABLE,
  migrateLegacyPresentationPreferences,
} = await import("./legacy-preferences-migration");

const fixture = {
  "stella-i18n": JSON.stringify({
    state: {
      lang: "cs",
      calendar: "islamic-umalqura",
      numberingSystem: "arab",
      regionalFormat: "en-IN",
      weekStart: "saturday",
    },
    version: 0,
  }),
  "stella-ui-theme": "dark",
  "stella-ui-palette": "nord",
  sidebar_state: "collapsed",
  "reader_provision_mode:u:user-1": JSON.stringify("expanded"),
  reader_text_scale: JSON.stringify(1.4),
  "stella.templates.density": "comfortable",
  "stella:inspector-pane-width:v2": "610",
  case_law_hidden_columns: JSON.stringify({
    cz: ["headnote", "language", "retiredColumn"],
    pol: {
      hidden: ["country", "retiredColumn"],
      order: ["summary", "caseNumber"],
      pinned: ["caseNumber"],
      sizing: { summary: 420, retiredColumn: 300 },
      contentMode: "fit-content",
      excerpt: "long",
    },
  }),
  statute_table_layout: JSON.stringify({
    sk: {
      hidden: ["amendments", "retiredColumn"],
      pinned: ["act"],
      sizing: { act: 420, retiredColumn: 300 },
    },
  }),
} as const;

const seedFixture = (language: "cs" | "ar" = "cs") => {
  for (const [key, value] of Object.entries(fixture)) {
    seedLegacyBrowserStorage(
      key,
      key === "stella-i18n"
        ? value.replace('"cs"', () => `"${language}"`)
        : value,
    );
  }
};

afterEach(() => {
  for (const key of Object.keys(fixture)) {
    legacyBrowserStorage.removeItem(key);
  }
});
afterAll(unregisterDomEnvironment);

const migrationLocales = UI_LOCALES.filter(
  (locale) => locale === "cs" || locale === "ar",
);

test.each(migrationLocales)(
  "upgrading populated legacy storage preserves %s and every replaced preference",
  async (language) => {
    seedFixture(language);
    let saved = defaultPresentationPrefs;
    let savedLocale = "en";
    const migrated = await migrateLegacyPresentationPreferences({
      prefs: saved,
      profileLocale: "en",
      userId: "user-1",
      writePrefs: async (patch) => {
        saved = { ...saved, ...patch };
        return saved;
      },
      writeProfileLocale: async (locale) => {
        savedLocale = locale;
        return Result.ok(undefined);
      },
    });

    expect(savedLocale).toBe(language);
    expect(migrated.prefs).toEqual({
      ...defaultPresentationPrefs,
      calendar: "islamic-umalqura",
      numberingSystem: "arab",
      regionalFormat: "en-IN",
      weekStart: "saturday",
      theme: "dark",
      palette: "nord",
      sidebarOpen: false,
      readerProvisionMode: "expanded",
      readerTextScale: 1.4,
      templateDensity: "comfortable",
      inspectorWidth: 610,
      decisionLayouts: {
        CZE: {
          ...DEFAULT_DECISION_TABLE_LAYOUT,
          hidden: ["headnote", "language"],
        },
        POL: {
          ...DEFAULT_DECISION_TABLE_LAYOUT,
          hidden: ["country"],
          order: ["summary", "caseNumber"],
          pinned: ["caseNumber"],
          sizing: { summary: 420 },
          contentMode: "fit-content",
          excerpt: "long",
        },
      },
      statuteLayouts: {
        SVK: {
          ...DEFAULT_STATUTE_TABLE_LAYOUT,
          hidden: ["amendments"],
          pinned: ["act"],
          sizing: { act: 420 },
        },
      },
    });
    expect(Object.keys(LEGACY_PRESENTATION_PREFERENCE_TABLE)).toEqual([
      "stella-i18n",
      "stella-ui-theme",
      "stella-ui-palette",
      "sidebar_state",
      "reader_provision_mode",
      "reader_text_scale",
      "stella.templates.density",
      "stella:inspector-pane-width:v2",
      "stella:inspector-pane-width:v1:matter",
      "stella:inspector-pane-width:v1:public-law",
      "case_law_hidden_columns",
      "statute_table_layout",
    ]);
    for (const key of Object.keys(fixture)) {
      expect(legacyBrowserStorage.getItem(key).unwrap()).toBeNull();
    }
  },
);

test("an explicit selection keeps its locale while still migrating other legacy preferences", async () => {
  seedFixture("cs");
  let profileWrites = 0;
  const migrated = await migrateLegacyPresentationPreferences({
    prefs: defaultPresentationPrefs,
    profileLocale: "en",
    userId: "user-1",
    localePriority: "explicit",
    writePrefs: async (patch) => ({ ...defaultPresentationPrefs, ...patch }),
    writeProfileLocale: async () => {
      profileWrites += 1;
      return Result.ok(undefined);
    },
  });
  expect(profileWrites).toBe(0);
  expect(migrated.locale).toBe("en");
  expect(migrated.prefs.visitorLocale).toBe("en");
  expect(migrated.prefs.theme).toBe("dark");
  expect(legacyBrowserStorage.getItem("stella-i18n").unwrap()).toBeNull();
});

test("a later profile locale is not overwritten by stale legacy data", async () => {
  seedFixture("cs");
  let profileWrites = 0;
  const currentPrefs = { ...defaultPresentationPrefs, theme: "light" as const };
  const migrated = await migrateLegacyPresentationPreferences({
    prefs: currentPrefs,
    profileLocale: "ar",
    userId: "user-1",
    writePrefs: async (patch) => ({ ...currentPrefs, ...patch }),
    writeProfileLocale: async () => {
      profileWrites += 1;
      return Result.ok(undefined);
    },
  });
  expect(migrated.locale).toBe("ar");
  expect(migrated.prefs.theme).toBe("light");
  expect(profileWrites).toBe(0);
});

test("a completed migration is a no-op when run twice", async () => {
  seedFixture();
  let writes = 0;
  const options = {
    prefs: defaultPresentationPrefs,
    profileLocale: "en" as const,
    userId: "user-1",
    writePrefs: async (patch: Partial<typeof defaultPresentationPrefs>) => {
      writes += 1;
      return { ...defaultPresentationPrefs, ...patch };
    },
    writeProfileLocale: async () => {
      writes += 1;
      return Result.ok(undefined);
    },
  };
  const first = await migrateLegacyPresentationPreferences(options);
  await migrateLegacyPresentationPreferences({
    ...options,
    prefs: first.prefs,
  });
  expect(writes).toBe(2);
});

test("a failed write leaves legacy entries for retry", async () => {
  seedFixture();
  const rejection = await rejectionOf(
    migrateLegacyPresentationPreferences({
      prefs: defaultPresentationPrefs,
      profileLocale: "ar",
      userId: "user-1",
      writePrefs: async () => {
        throw new Error("fixture write failed");
      },
      writeProfileLocale: async () => Result.ok(undefined),
    }),
  );
  expect(rejection).toBeInstanceOf(Error);
  expect(String(rejection)).toContain("fixture write failed");
  expect(legacyBrowserStorage.getItem("stella-ui-theme").unwrap()).toBe("dark");
  expect(legacyBrowserStorage.getItem("case_law_hidden_columns").unwrap()).toBe(
    fixture.case_law_hidden_columns,
  );
  expect(legacyBrowserStorage.getItem("statute_table_layout").unwrap()).toBe(
    fixture.statute_table_layout,
  );
});

test("a rejected profile locale keeps every legacy entry for a later boot", async () => {
  seedFixture("cs");
  const failure = new Error("profile unavailable");
  let preferenceWrites = 0;
  const migrated = await migrateLegacyPresentationPreferences({
    prefs: defaultPresentationPrefs,
    profileLocale: "en",
    userId: "user-1",
    writePrefs: async (patch) => {
      preferenceWrites += 1;
      return { ...defaultPresentationPrefs, ...patch };
    },
    writeProfileLocale: async () => Result.err(failure),
  });
  expect(migrated).toEqual({
    status: "profile-error",
    prefs: defaultPresentationPrefs,
    locale: "en",
    error: failure,
  });
  expect(preferenceWrites).toBe(0);
  for (const [key, value] of Object.entries(fixture)) {
    expect(legacyBrowserStorage.getItem(key).unwrap()).toBe(value);
  }
});

test("a valid layout too large for a cookie remains in local storage for retry", async () => {
  const wideDecision = JSON.stringify(
    Object.fromEntries(
      PUBLIC_COUNTRIES.map((country) => [
        country,
        {
          hidden: DECISION_COLUMN_IDS,
          order: DECISION_COLUMN_IDS,
          pinned: DECISION_COLUMN_IDS,
          sizing: Object.fromEntries(
            DECISION_COLUMN_IDS.map((id) => [id, 420]),
          ),
        },
      ]),
    ),
  );
  const wideStatute = JSON.stringify(
    Object.fromEntries(
      PUBLIC_COUNTRIES.map((country) => [
        country,
        {
          hidden: STATUTE_COLUMN_IDS,
          order: STATUTE_COLUMN_IDS,
          pinned: STATUTE_COLUMN_IDS,
          sizing: Object.fromEntries(STATUTE_COLUMN_IDS.map((id) => [id, 420])),
        },
      ]),
    ),
  );
  expect(encodeURIComponent(wideDecision).length).toBeGreaterThan(3500);
  expect(encodeURIComponent(wideStatute).length).toBeGreaterThan(3500);
  seedLegacyBrowserStorage("case_law_hidden_columns", wideDecision);
  seedLegacyBrowserStorage("statute_table_layout", wideStatute);
  seedLegacyBrowserStorage("stella-ui-theme", "dark");
  const migrated = await migrateLegacyPresentationPreferences({
    prefs: defaultPresentationPrefs,
    profileLocale: "ar",
    userId: "user-1",
    writePrefs: async (patch) => ({ ...defaultPresentationPrefs, ...patch }),
    writeProfileLocale: async () => Result.ok(undefined),
  });
  expect(migrated.prefs.theme).toBe("dark");
  expect(migrated.prefs.decisionLayouts).toEqual({});
  expect(migrated.prefs.statuteLayouts).toEqual({});
  expect(legacyBrowserStorage.getItem("case_law_hidden_columns").unwrap()).toBe(
    wideDecision,
  );
  expect(legacyBrowserStorage.getItem("statute_table_layout").unwrap()).toBe(
    wideStatute,
  );
  expect(legacyBrowserStorage.getItem("stella-ui-theme").unwrap()).toBeNull();
});

test("canonical country wins a legacy alias collision without deleting either original", async () => {
  const raw = JSON.stringify({
    CZE: { hidden: ["country"] },
    cz: ["headnote"],
  });
  seedLegacyBrowserStorage("case_law_hidden_columns", raw);
  const migrated = await migrateLegacyPresentationPreferences({
    prefs: defaultPresentationPrefs,
    profileLocale: "ar",
    userId: "user-1",
    writePrefs: async (patch) => ({ ...defaultPresentationPrefs, ...patch }),
    writeProfileLocale: async () => Result.ok(undefined),
  });
  expect(migrated.prefs.decisionLayouts["CZE"]?.hidden).toEqual(["country"]);
  expect(legacyBrowserStorage.getItem("case_law_hidden_columns").unwrap()).toBe(
    raw,
  );
});
