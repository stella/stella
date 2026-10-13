import { describe, expect, test } from "bun:test";

import { UI_LOCALES } from "@stll/locales";

import {
  defaultPresentationPrefs,
  parsePresentationPrefs,
  presentationPrefsSchema,
  serializePresentationPrefs,
} from "./presentation-prefs";

describe("server-readable presentation preferences", () => {
  test("missing, malformed and non-object cookies use defaults", () => {
    for (const raw of [
      undefined,
      "",
      "{",
      "null",
      "[]",
      '"dark"',
      "x".repeat(2049),
    ]) {
      expect(parsePresentationPrefs(raw)).toEqual(defaultPresentationPrefs);
    }
  });

  test("invalid fields default independently and unknown keys reject the cookie", () => {
    expect(
      parsePresentationPrefs(
        JSON.stringify({
          sidebarOpen: false,
          theme: "injected",
          inspectorWidth: -1,
          palette: "nord",
        }),
      ),
    ).toEqual({
      ...defaultPresentationPrefs,
      sidebarOpen: false,
      palette: "nord",
    });
    expect(
      parsePresentationPrefs('{"sidebarOpen":false,"unknown":true}'),
    ).toEqual(defaultPresentationPrefs);
    for (const inspectorWidth of [null, "512", 319, 1401, 500.5]) {
      expect(
        parsePresentationPrefs(JSON.stringify({ inspectorWidth }))
          .inspectorWidth,
      ).toBe(defaultPresentationPrefs.inspectorWidth);
    }
  });

  test("every theme, palette, density and sidebar combination survives a bounded round trip", () => {
    for (const theme of presentationPrefsSchema.entries.theme.options) {
      for (const palette of presentationPrefsSchema.entries.palette.options) {
        for (const templateDensity of presentationPrefsSchema.entries
          .templateDensity.options) {
          for (const sidebarOpen of [false, true]) {
            for (const inspectorWidth of [320, 512, 1400]) {
              const prefs = {
                ...defaultPresentationPrefs,
                theme,
                palette,
                templateDensity,
                sidebarOpen,
                inspectorWidth,
              };
              const cookie = serializePresentationPrefs(prefs);
              expect(cookie.length).toBeLessThan(2048);
              expect(parsePresentationPrefs(cookie)).toEqual(prefs);
            }
          }
        }
      }
    }
  });

  test("anonymous interface locale round trips for every shipped catalogue", () => {
    for (const visitorLocale of UI_LOCALES) {
      const prefs = { ...defaultPresentationPrefs, visitorLocale };
      expect(parsePresentationPrefs(serializePresentationPrefs(prefs))).toEqual(
        prefs,
      );
    }
    expect(
      parsePresentationPrefs('{"visitorLocale":"invalid"}').visitorLocale,
    ).toBe("en");
  });

  test("formatting preferences validate before reaching the formatter", () => {
    const prefs = {
      ...defaultPresentationPrefs,
      region: "CZ",
      calendar: "islamic-umalqura",
      numberingSystem: "arab",
      weekStart: "saturday",
      regionalFormat: "en-IN",
    } as const;
    expect(parsePresentationPrefs(serializePresentationPrefs(prefs))).toEqual(
      prefs,
    );
    expect(
      parsePresentationPrefs('{"region":"<script>","calendar":"bogus"}'),
    ).toEqual(defaultPresentationPrefs);
  });
});
