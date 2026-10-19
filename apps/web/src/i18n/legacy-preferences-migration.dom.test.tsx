import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { UI_LOCALES } from "@stll/locales";
import { rejectionOf } from "@stll/property-testing/rejection";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/" });

const { legacyBrowserStorage } = await import("@/lib/account/browser-storage");
const { seedLegacyBrowserStorage } =
  await import("@/lib/account/browser-storage.test-fixtures");
const { defaultPresentationPrefs } =
  await import("@/lib/account/presentation-prefs/preferences");
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
  case_law_hidden_columns: JSON.stringify({}),
  statute_table_layout: JSON.stringify({}),
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
      writeProfileLocale: async () => undefined,
    }),
  );
  expect(rejection).toBeInstanceOf(Error);
  expect(String(rejection)).toContain("fixture write failed");
  expect(legacyBrowserStorage.getItem("stella-ui-theme").unwrap()).toBe("dark");
});
