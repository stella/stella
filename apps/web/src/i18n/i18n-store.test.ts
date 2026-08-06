import { beforeEach, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";

import { UI_LOCALES } from "@stll/locales";

import {
  buildFormattingLocale,
  getFormatter,
  getFormattingLocale,
  getMessageLocale,
  getLangDir,
  supportedLanguages,
  useI18nStore,
} from "@/i18n/i18n-store";
import en from "@/i18n/langs/en.json";

type PrepaintOptions = {
  languages?: readonly string[];
  prefersDark?: boolean;
  storage?: Readonly<Record<string, string>>;
  storageThrows?: boolean;
};

const runPrepaint = async ({
  languages = [],
  prefersDark = false,
  storage = {},
  storageThrows = false,
}: PrepaintOptions = {}) => {
  const source = await Bun.file(
    new URL("../../public/prepaint-init.js", import.meta.url),
  ).text();
  const classNames = new Set<string>();
  const documentElement = {
    lang: "en",
    dir: "ltr",
    classList: {
      add: (...tokens: string[]) => {
        for (const token of tokens) {
          if (/\s/u.test(token)) {
            throw new DOMException(
              "The token contains HTML space characters",
              "InvalidCharacterError",
            );
          }
          classNames.add(token);
        }
      },
    },
    style: {
      colorScheme: "",
      backgroundColor: "",
    },
  };

  runInNewContext(source, {
    document: { documentElement },
    localStorage: {
      getItem: (key: string) => {
        if (storageThrows) {
          throw new DOMException("Storage is unavailable", "SecurityError");
        }
        return storage[key] ?? null;
      },
    },
    matchMedia: () => ({ matches: prefersDark }),
    navigator: { languages },
  });

  return { classNames, documentElement };
};

// Baseline: the app has already booted in English, so the boot latch is on.
const resetToBootedEnglish = (): void => {
  useI18nStore.setState({
    lang: "en",
    messages: en,
    loadedLang: "en",
    isLoaded: true,
    hasLoadedOnce: true,
    region: "US",
    regionalFormat: "auto",
    calendar: "auto",
    numberingSystem: "auto",
    weekStart: "auto",
  });
  void useI18nStore.getState().loadMessages("en");
};

beforeEach(() => {
  resetToBootedEnglish();
});

test("switching to an unbundled language keeps the boot latch on", async () => {
  const isLoadedSeen: boolean[] = [];
  const hasLoadedOnceSeen: boolean[] = [];
  const unsubscribe = useI18nStore.subscribe((state) => {
    isLoadedSeen.push(state.isLoaded);
    hasLoadedOnceSeen.push(state.hasLoadedOnce);
  });

  await useI18nStore.getState().setLang("cs");
  unsubscribe();

  // A non-English bundle is loaded async, so isLoaded must dip false while it
  // streams in. That dip is exactly what used to unmount the app (and any
  // in-progress onboarding) via the boot spinner.
  expect(isLoadedSeen).toContain(false);

  // The boot latch must stay on through the whole switch, so the provider
  // keeps the app mounted and swaps the locale in place.
  expect(hasLoadedOnceSeen.every(Boolean)).toBe(true);

  const state = useI18nStore.getState();
  expect(state.loadedLang).toBe("cs");
  expect(state.isLoaded).toBe(true);
  expect(state.messages).not.toBe(en);
});

test("cold boot into a persisted non-English language holds the spinner", async () => {
  // Post-hydration cold boot: the persisted language is non-English, only the
  // bundled English messages are loaded, and the latch has not fired yet.
  useI18nStore.setState({
    lang: "cs",
    messages: en,
    loadedLang: "en",
    isLoaded: false,
    hasLoadedOnce: false,
  });

  const load = useI18nStore.getState().loadMessages("cs");

  // While the Czech bundle streams in the latch must stay off, so the provider
  // keeps the boot spinner up instead of flashing the English bundle first.
  expect(useI18nStore.getState().hasLoadedOnce).toBe(false);

  await load;

  const state = useI18nStore.getState();
  expect(state.hasLoadedOnce).toBe(true);
  expect(state.loadedLang).toBe("cs");
});

test("cold boot in English latches the spinner off synchronously", async () => {
  // The English bundle ships with the app, so loadMessages resolves on the sync
  // fast path and must latch before the first render (no boot spinner flash).
  useI18nStore.setState({
    lang: "en",
    messages: en,
    loadedLang: "en",
    isLoaded: true,
    hasLoadedOnce: false,
  });

  const load = useI18nStore.getState().loadMessages("en");
  expect(useI18nStore.getState().hasLoadedOnce).toBe(true);
  await load;
});

test("every supported language resolves to a known writing direction", () => {
  for (const lang of supportedLanguages) {
    expect(["ltr", "rtl"]).toContain(getLangDir(lang));
  }
});

test("prepaint-init.js locale sets match the i18n sources", async () => {
  // public/prepaint-init.js runs before the bundle loads, so it cannot
  // import UI_LOCALES or LANG_DIR and duplicates them instead. Adding a
  // language without updating the script would make first-paint detection
  // diverge from the application, so pin both sets to their sources here.
  const source = await Bun.file(
    new URL("../../public/prepaint-init.js", import.meta.url),
  ).text();

  const declaredUiLocales = /const UI_LOCALES = \[(.*?)\];/su.exec(source);
  const declaredRtlLocales = /const RTL_LOCALES = \[(.*?)\];/su.exec(source);
  expect(declaredUiLocales).not.toBeNull();
  expect(declaredRtlLocales).not.toBeNull();

  // Locale tags are ASCII identifiers, not user-facing text, so order them
  // by code point rather than with a locale-aware collator.
  const byCodePoint = (a: string, b: string) => (a < b ? -1 : Number(a > b));
  const scriptUiLocales = [
    ...(declaredUiLocales?.[1] ?? "").matchAll(/"([^"]+)"/gu),
  ]
    .map((match) => match[1] ?? "")
    .sort(byCodePoint);
  const scriptRtlLocales = [
    ...(declaredRtlLocales?.[1] ?? "").matchAll(/"([^"]+)"/gu),
  ]
    .map((match) => match[1] ?? "")
    .sort(byCodePoint);
  const expectedUiLocales = [...UI_LOCALES].sort(byCodePoint);
  const expectedRtlLocales = UI_LOCALES.filter(
    (lang) => getLangDir(lang) === "rtl",
  ).toSorted(byCodePoint);

  expect(scriptUiLocales).toEqual(expectedUiLocales);
  expect(scriptRtlLocales).toEqual(expectedRtlLocales);
});

test("prepaint-init.js uses the first supported browser locale", async () => {
  const arabicFirst = await runPrepaint({ languages: ["ar-SA", "en-US"] });
  expect(arabicFirst.documentElement.lang).toBe("ar");
  expect(arabicFirst.documentElement.dir).toBe("rtl");

  const englishFirst = await runPrepaint({ languages: ["en-US", "ar-SA"] });
  expect(englishFirst.documentElement.lang).toBe("en");
  expect(englishFirst.documentElement.dir).toBe("ltr");
});

test("prepaint-init.js prefers the persisted locale", async () => {
  const result = await runPrepaint({
    languages: ["en-US"],
    storage: {
      "stella-i18n": JSON.stringify({ state: { lang: "ar" }, version: 0 }),
    },
  });

  expect(result.documentElement.lang).toBe("ar");
  expect(result.documentElement.dir).toBe("rtl");
});

test("prepaint-init.js survives malformed or unavailable storage", async () => {
  const malformed = await runPrepaint({
    languages: ["ar-SA"],
    storage: {
      "stella-i18n": "{",
      "stella-ui-palette": "invalid palette",
    },
  });
  expect(malformed.documentElement.lang).toBe("ar");
  expect(malformed.documentElement.dir).toBe("rtl");

  const unavailable = await runPrepaint({
    languages: ["ar-SA"],
    storageThrows: true,
  });
  expect(unavailable.documentElement.lang).toBe("ar");
  expect(unavailable.documentElement.dir).toBe("rtl");
});

test("prepaint-init.js preserves valid theme and palette preferences", async () => {
  const result = await runPrepaint({
    storage: {
      "stella-ui-palette": "nord",
      "stella-ui-theme": "dark",
    },
  });

  expect(result.classNames).toEqual(new Set(["dark", "palette-nord"]));
  expect(result.documentElement.style.colorScheme).toBe("dark");
  expect(result.documentElement.style.backgroundColor).toBe("#0c0c0d");
});

test("buildFormattingLocale never builds an invalid tag for any language + region", () => {
  // "pt-BR" already encodes a region; appending another (e.g. "BR") would
  // build "pt-BR-BR", which Intl.Locale rejects.
  for (const lang of supportedLanguages) {
    const tag = buildFormattingLocale({
      lang,
      region: "BR",
      regionalFormat: "auto",
      calendar: "islamic-umalqura",
      numberingSystem: "arab",
      weekStart: "sunday",
    });
    expect(() => new Intl.Locale(tag)).not.toThrow();
  }
});

test("Indian regional format uses lakh and crore grouping", () => {
  useI18nStore.getState().setRegionalFormat("en-IN");

  expect(getFormattingLocale()).toBe("en-IN");
  expect(
    getFormatter().number(12_345_678.9, {
      style: "currency",
      currency: "INR",
      minimumFractionDigits: 2,
    }),
  ).toBe("₹1,23,45,678.90");
});

test("regional format stays independent from the display language", async () => {
  useI18nStore.getState().setRegionalFormat("en-IN");
  await useI18nStore.getState().setLang("de");

  expect(useI18nStore.getState().lang).toBe("de");
  expect(getMessageLocale()).toBe("de");
  expect(getFormattingLocale()).toBe("en-IN");
});

test("automatic regional format restores the detected language-region pair", () => {
  useI18nStore.getState().setRegionalFormat("en-IN");
  useI18nStore.getState().setRegionalFormat("auto");

  expect(getFormattingLocale()).toBe("en-US");
  expect(
    getFormatter().number(12_345_678.9, {
      style: "currency",
      currency: "INR",
      minimumFractionDigits: 2,
    }),
  ).toBe("₹12,345,678.90");
});

test("loadedLang and messages advance together", async () => {
  await useI18nStore.getState().setLang("cs");
  const afterCs = useI18nStore.getState();
  expect(afterCs.loadedLang).toBe("cs");
  const csMessages = afterCs.messages;

  await useI18nStore.getState().setLang("en");
  const afterEn = useI18nStore.getState();
  expect(afterEn.loadedLang).toBe("en");
  expect(afterEn.messages).not.toBe(csMessages);
  expect(afterEn.hasLoadedOnce).toBe(true);
});
