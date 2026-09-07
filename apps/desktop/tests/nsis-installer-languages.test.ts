import { describe, expect, test } from "bun:test";

import tauriConfig from "../src-tauri/tauri.conf.json" with { type: "json" };
// Type-only: the i18n module reaches for the Tauri event API at import time,
// which no test process provides.
import type { SupportedLanguage } from "../src/i18n/index";

// NSIS identifies a language by name, not by tag, so the pairing cannot be
// derived. `satisfies` keeps the map total in both directions: a locale added
// to the app fails to compile until it is answered here, and a locale the app
// dropped fails as an excess key.
const NSIS_LANGUAGE_BY_LOCALE = {
  cs: "Czech",
  de: "German",
  en: "English",
  es: "Spanish",
  et: "Estonian",
  fr: "French",
  hu: "Hungarian",
  lt: "Lithuanian",
  lv: "Latvian",
  pl: "Polish",
  sk: "Slovak",
} as const satisfies Record<SupportedLanguage, string>;

describe("NSIS installer languages", () => {
  test("are exactly the languages the app's locales map to", () => {
    expect([...tauriConfig.bundle.windows.nsis.languages].toSorted()).toEqual(
      Object.values(NSIS_LANGUAGE_BY_LOCALE).toSorted(),
    );
  });
});
