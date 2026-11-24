import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import tauriConfig from "../src-tauri/tauri.conf.json" with { type: "json" };
// Type-only: the i18n module reaches for the Tauri event API at import time,
// which no test process provides.
import type { SupportedLanguage } from "../src/i18n/index";

// NSIS identifies a language by name, not by tag, so the pairing cannot be
// derived. `satisfies` keeps the map total in both directions: a locale added
// to the app fails to compile until it is answered here, and a locale the app
// dropped fails as an excess key.
const NSIS_LANGUAGE_BY_LOCALE = {
  ar: "Arabic",
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
  "pt-BR": "PortugueseBR",
  sk: "Slovak",
} as const satisfies Record<SupportedLanguage, string>;

const TAURI_DIR = path.join(import.meta.dir, "../src-tauri");
const { languages, customLanguageFiles } = tauriConfig.bundle.windows.nsis;
const customLanguageFileByLanguage = new Map(
  Object.entries(customLanguageFiles),
);

// Tauri's installer template labels its own controls (the finish page's
// desktop shortcut checkbox among them) with LangStrings it embeds in the CLI
// for some languages only; NSIS compiles a missing one to an empty label. The
// CLI that builds the installer is therefore the source of truth for which
// messages exist.
const LANG_STRING = /LangString (\w+) \$\{LANG_([A-Z]+)\} "([^"\n]*)"/gu;
const LANG_STRING_LINE = /^LangString (\w+) \$\{LANG_([A-Z]+)\} "([^"\n]*)"$/u;
// NSIS variables, defines and escapes; a translation keeps every one.
const NSIS_TOKEN = /\$\{\w+\}|\$R\d|\$\d|\$\\./gu;

type LangStringTable = Map<string, string>;

const nsisLanguageId = (language: string) => language.toUpperCase();

const tablesByLanguage = (text: string) => {
  const tables = new Map<string, LangStringTable>();
  for (const [, key, language, value] of text.matchAll(LANG_STRING)) {
    if (key === undefined || language === undefined || value === undefined) {
      return panic("LangString pattern lost a capture group");
    }
    const table = tables.get(language) ?? new Map<string, string>();
    table.set(key, value);
    tables.set(language, table);
  }
  return tables;
};

const tauriCliBinary = () => {
  const cliDir = path.dirname(
    realpathSync(Bun.resolveSync("@tauri-apps/cli/package.json", TAURI_DIR)),
  );
  // The CLI's optional `@tauri-apps/cli-<platform>` dependency, installed
  // next to it, carries the native binary.
  const scopeDir = path.dirname(cliDir);
  const platformDir = readdirSync(scopeDir)
    .filter((entry) => entry.startsWith("cli-"))
    .map((entry) => path.join(scopeDir, entry))
    .at(0);
  if (platformDir === undefined) {
    return panic(`no Tauri CLI platform binary installed in ${scopeDir}`);
  }
  const binary = readdirSync(platformDir).find((entry) =>
    entry.endsWith(".node"),
  );
  if (binary === undefined) {
    return panic(`no native module in ${platformDir}`);
  }
  return path.join(platformDir, binary);
};

// Built-in messages are ASCII-keyed; latin1 keeps the binary byte for byte.
const cliTables = tablesByLanguage(readFileSync(tauriCliBinary(), "latin1"));
const englishTable =
  cliTables.get("ENGLISH") ?? panic("Tauri CLI embeds no English messages");
const requiredKeys = [...englishTable.keys()].toSorted();

const readCustomTable = (language: string, file: string) => {
  const table: LangStringTable = new Map();
  const lines = readFileSync(path.join(TAURI_DIR, file), "utf-8")
    .split(/\r?\n/u)
    .filter((line) => line !== "");
  for (const line of lines) {
    const [, key, languageId, value] = LANG_STRING_LINE.exec(line) ?? [];
    if (key === undefined || value === undefined) {
      return panic(`${file}: not a LangString line: ${line}`);
    }
    expect(languageId, `${file}: ${key}`).toBe(nsisLanguageId(language));
    expect(table.has(key), `${file}: ${key} defined twice`).toBe(false);
    table.set(key, value);
  }
  return table;
};

const tableFor = (language: string) => {
  const custom = customLanguageFileByLanguage.get(language);
  return custom === undefined
    ? cliTables.get(nsisLanguageId(language))
    : readCustomTable(language, custom);
};

// Tauri's built-in English names the product as `{{product_name}}`, which
// nothing renders in an included file; custom files use the NSIS define.
// oxlint-disable-next-line no-template-curly-in-string -- the literal NSIS define, not an interpolation
const PRODUCT_NAME_DEFINE = "${PRODUCTNAME}";
const placeholders = (value: string) =>
  (
    value
      .replaceAll("{{product_name}}", () => PRODUCT_NAME_DEFINE)
      .match(NSIS_TOKEN) ?? []
  ).toSorted();

describe("NSIS installer languages", () => {
  test("are exactly the languages the app's locales map to", () => {
    expect([...languages].toSorted()).toEqual(
      Object.values(NSIS_LANGUAGE_BY_LOCALE).toSorted(),
    );
  });

  test("read the installer messages from the Tauri CLI", () => {
    expect(requiredKeys).toContain("createDesktop");
  });

  test.each([...languages])("%s labels every installer message", (language) => {
    const table = tableFor(language);
    expect(table, `${language} has no Tauri or custom messages`).toBeDefined();
    const missing = requiredKeys.filter((key) => !table?.get(key));
    expect(missing).toEqual([]);
  });

  test.each([...customLanguageFileByLanguage])(
    "%s custom messages match the template one for one",
    (language, file) => {
      expect(languages).toContain(language);
      const table = readCustomTable(language, file);
      expect([...table.keys()].toSorted()).toEqual(requiredKeys);
      for (const [key, english] of englishTable) {
        expect(placeholders(table.get(key) ?? ""), key).toEqual(
          placeholders(english),
        );
      }
    },
  );
});
