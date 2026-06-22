#!/usr/bin/env bun
/**
 * Generates the canonical term tables in TERMINOLOGY.md from the
 * machine-readable term base glossary.json (the source of truth).
 * Tables are spliced between `<!-- glossary-gen:<id> start -->` and
 * `<!-- glossary-gen:<id> end -->` markers; prose around them is left
 * untouched. The same glossary.json feeds glossary injection into
 * machine translation and terminology linting downstream.
 *
 * Usage: glossary-gen <i18n-dir> [--check]
 *
 * --check  Verify the on-disk TERMINOLOGY.md matches what would be
 *          generated from glossary.json. Exits non-zero on drift
 *          without writing.
 */
import { panic } from "better-result";
import path from "node:path";

// All 12 non-English locales.
export const LOCALES = [
  "ar",
  "cs",
  "sk",
  "pl",
  "de",
  "et",
  "hu",
  "lt",
  "lv",
  "es",
  "fr",
  "pt-BR",
] as const;

export type Locale = (typeof LOCALES)[number];

const LOCALE_SET: ReadonlySet<string> = new Set(LOCALES);

// Column groupings keep each Markdown table narrow enough to read.
const GROUP_SLAVIC_BALTIC: Locale[] = [
  "cs",
  "sk",
  "pl",
  "de",
  "et",
  "hu",
  "lt",
  "lv",
];
const GROUP_ROMANCE: Locale[] = ["es", "fr", "pt-BR"];
// Arabic is rendered in its own table: it is RTL and a different script.
const GROUP_ARABIC: Locale[] = ["ar"];

const LOCALE_LABEL: Record<Locale, string> = {
  ar: "Arabic",
  cs: "Czech",
  sk: "Slovak",
  pl: "Polish",
  de: "German",
  et: "Estonian",
  hu: "Hungarian",
  lt: "Lithuanian",
  lv: "Latvian",
  es: "Spanish",
  fr: "French",
  "pt-BR": "Brazilian Portuguese",
};

export type Term = {
  id: string;
  en: string;
  note?: string;
  forbidden?: Record<string, string[]>;
  translations: Record<Locale, string>;
};

export type PtBrTerm = {
  en: string;
  "pt-BR": string;
  note: string;
};

export type Glossary = {
  verbs: Term[];
  legalConcepts: Term[];
  ptBR: PtBrTerm[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseTerm = (value: unknown, where: string): Term => {
  if (!isRecord(value) || typeof value["id"] !== "string") {
    return panic(`${where}: each term needs a string \`id\``);
  }
  const id = value["id"];
  if (typeof value["en"] !== "string") {
    return panic(`${where} (${id}): missing \`en\``);
  }
  const rawTranslations = value["translations"];
  if (!isRecord(rawTranslations)) {
    return panic(`${where} (${id}): missing \`translations\``);
  }

  const translations: Record<string, string> = {};
  for (const locale of LOCALES) {
    const translated = rawTranslations[locale];
    if (typeof translated !== "string") {
      return panic(`${where} (${id}): missing translation for "${locale}"`);
    }
    translations[locale] = translated;
  }
  for (const key of Object.keys(rawTranslations)) {
    if (!LOCALE_SET.has(key)) {
      return panic(`${where} (${id}): unknown locale "${key}" in translations`);
    }
  }

  const term: Term = { id, en: value["en"], translations };
  const note = value["note"];
  if (typeof note === "string") {
    term.note = note;
  }
  const rawForbidden = value["forbidden"];
  if (rawForbidden !== undefined && !isRecord(rawForbidden)) {
    return panic(
      `${where} (${id}): \`forbidden\` must be an object keyed by locale`,
    );
  }
  if (isRecord(rawForbidden)) {
    const forbidden: Record<string, string[]> = {};
    for (const [locale, words] of Object.entries(rawForbidden)) {
      if (!LOCALE_SET.has(locale)) {
        return panic(
          `${where} (${id}): unknown locale "${locale}" in \`forbidden\``,
        );
      }
      if (!Array.isArray(words)) {
        return panic(
          `${where} (${id}): \`forbidden.${locale}\` must be an array of strings`,
        );
      }
      for (const word of words) {
        if (typeof word !== "string") {
          return panic(
            `${where} (${id}): \`forbidden.${locale}\` must contain only strings`,
          );
        }
      }
      forbidden[locale] = words;
    }
    term.forbidden = forbidden;
  }
  return term;
};

const parsePtBrTerm = (value: unknown): PtBrTerm => {
  if (
    !isRecord(value) ||
    typeof value["en"] !== "string" ||
    typeof value["pt-BR"] !== "string" ||
    typeof value["note"] !== "string"
  ) {
    return panic("ptBR: each entry needs string `en`, `pt-BR`, and `note`");
  }
  return { en: value["en"], "pt-BR": value["pt-BR"], note: value["note"] };
};

export const parseGlossary = (json: string): Glossary => {
  const parsed: unknown = JSON.parse(json);
  if (
    !isRecord(parsed) ||
    !Array.isArray(parsed["verbs"]) ||
    !Array.isArray(parsed["legalConcepts"]) ||
    !Array.isArray(parsed["ptBR"])
  ) {
    return panic("glossary.json must have `verbs`, `legalConcepts`, `ptBR`");
  }

  return {
    verbs: parsed["verbs"].map((v: unknown) => parseTerm(v, "verbs")),
    legalConcepts: parsed["legalConcepts"].map((v: unknown) =>
      parseTerm(v, "legalConcepts"),
    ),
    ptBR: parsed["ptBR"].map((v: unknown) => parsePtBrTerm(v)),
  };
};

// Display width counts NFC code points, matching how oxfmt/GFM align cells,
// so generated tables are a formatter fixpoint (no reflow on `bun run format`).
const width = (cell: string): number =>
  Array.from(cell.normalize("NFC")).length;

export const renderTable = (headers: string[], rows: string[][]): string => {
  const widths = headers.map((header, col) =>
    Math.max(width(header), ...rows.map((row) => width(row[col] ?? ""))),
  );
  const renderRow = (cells: string[]): string =>
    `| ${cells
      .map((cell, col) => cell + " ".repeat((widths[col] ?? 0) - width(cell)))
      .join(" | ")} |`;
  const separator = `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`;

  return [renderRow(headers), separator, ...rows.map(renderRow)].join("\n");
};

const termTable = (
  terms: Term[],
  firstHeader: string,
  group: Locale[],
): string =>
  renderTable(
    [firstHeader, ...group.map((locale) => LOCALE_LABEL[locale])],
    terms.map((term) => [
      `**${term.en}**`,
      ...group.map((locale) => term.translations[locale]),
    ]),
  );

const buildTables = (glossary: Glossary): Record<string, string> => ({
  "verbs-slavic-baltic": termTable(glossary.verbs, "Verb", GROUP_SLAVIC_BALTIC),
  "verbs-romance": termTable(glossary.verbs, "Verb", GROUP_ROMANCE),
  "legal-slavic-baltic": termTable(
    glossary.legalConcepts,
    "Concept",
    GROUP_SLAVIC_BALTIC,
  ),
  "legal-romance": termTable(glossary.legalConcepts, "Concept", GROUP_ROMANCE),
  "verbs-arabic": termTable(glossary.verbs, "Verb", GROUP_ARABIC),
  "legal-arabic": termTable(glossary.legalConcepts, "Concept", GROUP_ARABIC),
  "ptbr-special": renderTable(
    ["English", "pt-BR", "Notes"],
    glossary.ptBR.map((term) => [term.en, term["pt-BR"], term.note]),
  ),
});

export const generate = (terminology: string, glossary: Glossary): string => {
  let result = terminology;
  for (const [id, table] of Object.entries(buildTables(glossary))) {
    const startTag = `<!-- glossary-gen:${id} start -->`;
    const endTag = `<!-- glossary-gen:${id} end -->`;
    const start = result.indexOf(startTag);
    const end = result.indexOf(endTag);
    if (start === -1 || end === -1 || end < start) {
      return panic(
        `TERMINOLOGY.md is missing the \`${id}\` markers (${startTag} … ${endTag})`,
      );
    }
    // Blank lines around the table match oxfmt's Markdown block separation
    // (HTML comment and table are distinct blocks), so generated output is a
    // formatter fixpoint and `--check` stays an exact comparison.
    result = `${result.slice(0, start + startTag.length)}\n\n${table}\n\n${result.slice(end)}`;
  }
  return result;
};

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const i18nDir =
      args.find((a) => !a.startsWith("--")) ??
      panic("Usage: glossary-gen <i18n-dir> [--check]");
    const checkOnly = args.includes("--check");

    const glossaryPath = path.resolve(i18nDir, "glossary.json");
    const terminologyPath = path.resolve(i18nDir, "TERMINOLOGY.md");

    const glossary = parseGlossary(await Bun.file(glossaryPath).text());
    const existing = await Bun.file(terminologyPath).text();
    const next = generate(existing, glossary);

    const termCount = glossary.verbs.length + glossary.legalConcepts.length;

    if (checkOnly) {
      if (existing !== next) {
        panic(
          `Error: ${terminologyPath} is out of sync with glossary.json. Run \`bun run i18n:sync\`.`,
        );
      }
      console.log(`${terminologyPath} is in sync (${termCount} terms)`);
    } else {
      await Bun.write(terminologyPath, next);
      console.log(`Generated ${terminologyPath} (${termCount} terms)`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
