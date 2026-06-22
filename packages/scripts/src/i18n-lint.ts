#!/usr/bin/env bun
/**
 * Quality lint for locale files, beyond i18n-check's structural checks.
 * For every translated string (skipping untranslated values, which
 * i18n-check already tracks) it verifies:
 *
 *  - placeholder parity: the {var} set matches the en source (no dropped,
 *    renamed, or extra interpolation variables) — a silent runtime bug the
 *    type system cannot catch, since only the en source is typed.
 *  - ICU validity: the value parses as ICU MessageFormat (catches broken
 *    plural/select syntax and apostrophe/brace-escaping mistakes).
 *  - plural categories: each plural argument carries every CLDR plural
 *    category the target locale needs (e.g. Polish few/many, Arabic's six).
 *  - terminology: per-locale renderings marked `forbidden` in glossary.json
 *    do not appear (keeps canonical terms consistent across the product).
 *
 * Existing debt is grandfathered in i18n-lint-baseline.json so the gate
 * catches only NEW regressions. Burn the baseline down over time.
 *
 * Usage: i18n-lint <langs-dir> [--write-baseline]
 *
 * --write-baseline  Regenerate i18n-lint-baseline.json from the current
 *                   state, grandfathering today's violations.
 */
import { parse, TYPE } from "@formatjs/icu-messageformat-parser";
import type { MessageFormatElement } from "@formatjs/icu-messageformat-parser";
import { panic } from "better-result";
import path from "node:path";

import { parseGlossary } from "./glossary-gen";
import type { Glossary } from "./glossary-gen";
import type { NestedMessages } from "./i18n-check";

const flatten = (
  obj: NestedMessages,
  prefix = "",
  out: Record<string, string> = {},
): Record<string, string> => {
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      out[fullKey] = value;
    } else {
      flatten(value, fullKey, out);
    }
  }
  return out;
};

const safeParse = (value: string): MessageFormatElement[] | null => {
  try {
    return parse(value);
  } catch {
    return null;
  }
};

const collectArgNames = (
  elements: MessageFormatElement[],
  names: Set<string>,
): void => {
  for (const element of elements) {
    switch (element.type) {
      case TYPE.argument:
      case TYPE.number:
      case TYPE.date:
      case TYPE.time:
        names.add(element.value);
        break;
      case TYPE.select:
      case TYPE.plural:
        names.add(element.value);
        for (const option of Object.values(element.options)) {
          collectArgNames(option.value, names);
        }
        break;
      case TYPE.tag:
        collectArgNames(element.children, names);
        break;
      default:
        break;
    }
  }
};

/**
 * Interpolation variables present in the source but missing from the target,
 * or present in the target but absent from the source. Returns null when both
 * sides parse and their variable sets match (ICU errors are reported by
 * findIcuError, so unparseable input is skipped here).
 */
export const findPlaceholderMismatch = (
  source: string,
  target: string,
): { missing: string[]; extra: string[] } | null => {
  const sourceAst = safeParse(source);
  const targetAst = safeParse(target);
  if (!sourceAst || !targetAst) {
    return null;
  }

  const sourceNames = new Set<string>();
  const targetNames = new Set<string>();
  collectArgNames(sourceAst, sourceNames);
  collectArgNames(targetAst, targetNames);

  const missing = [...sourceNames].filter((name) => !targetNames.has(name));
  const extra = [...targetNames].filter((name) => !sourceNames.has(name));
  if (missing.length === 0 && extra.length === 0) {
    return null;
  }
  return { missing, extra };
};

/** ICU parse error message, or null when the value is valid ICU MessageFormat. */
export const findIcuError = (value: string): string | null => {
  try {
    parse(value);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

/**
 * Plural categories the target locale requires (per CLDR) but the value omits,
 * reported as `arg#category`. Exact selectors (`=0`, `=1`) do not count toward
 * the CLDR categories.
 */
export const findMissingPluralCategories = (
  value: string,
  locale: string,
): string[] => {
  const ast = safeParse(value);
  if (!ast) {
    return [];
  }

  const missing: string[] = [];
  const walk = (elements: MessageFormatElement[]): void => {
    for (const element of elements) {
      if (element.type === TYPE.plural) {
        const type = element.pluralType === "ordinal" ? "ordinal" : "cardinal";
        const required = new Intl.PluralRules(locale, {
          type,
        }).resolvedOptions().pluralCategories;
        const present = new Set(
          Object.keys(element.options).filter((key) => !key.startsWith("=")),
        );
        for (const category of required) {
          if (!present.has(category)) {
            missing.push(`${element.value}#${category}`);
          }
        }
      }
      if (element.type === TYPE.plural || element.type === TYPE.select) {
        for (const option of Object.values(element.options)) {
          walk(option.value);
        }
      }
      if (element.type === TYPE.tag) {
        walk(element.children);
      }
    }
  };
  walk(ast);
  return missing;
};

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Whole-word, script-aware (Unicode) containment test. */
const containsWord = (haystack: string, needle: string): boolean =>
  new RegExp(`(?<!\\p{L})${escapeRegExp(needle)}(?!\\p{L})`, "iu").test(
    haystack,
  );

export type ForbiddenRule = {
  concept: string;
  triggers: string[];
  byLocale: Record<string, string[]>;
};

/**
 * Terminology rules from glossary `forbidden`, each scoped to its concept's
 * English trigger word(s). A forbidden rendering is only flagged when the
 * source string is actually about that concept; otherwise a common word (e.g.
 * Estonian "asi") would false-fire on unrelated strings.
 */
export const buildForbiddenRules = (glossary: Glossary): ForbiddenRule[] => {
  const rules: ForbiddenRule[] = [];
  for (const term of [...glossary.verbs, ...glossary.legalConcepts]) {
    if (!term.forbidden) {
      continue;
    }
    const byLocale: Record<string, string[]> = {};
    for (const [locale, words] of Object.entries(term.forbidden)) {
      byLocale[locale] = words;
    }
    rules.push({ concept: term.id, triggers: [term.en], byLocale });
  }
  return rules;
};

/** Forbidden renderings present in the target for concepts the source mentions. */
export const findForbiddenTerms = (
  source: string,
  target: string,
  locale: string,
  rules: ForbiddenRule[],
): string[] => {
  const hits: string[] = [];
  for (const rule of rules) {
    const forbidden = rule.byLocale[locale];
    if (
      !forbidden ||
      !rule.triggers.some((trigger) => containsWord(source, trigger))
    ) {
      continue;
    }
    for (const term of forbidden) {
      if (containsWord(target, term)) {
        hits.push(term);
      }
    }
  }
  return hits;
};

// --- baseline ---

type LintCategory = "placeholder" | "icu" | "plural" | "terminology";

type LintBaseline = Record<LintCategory, Record<string, string[]>>;

const CATEGORIES: LintCategory[] = [
  "placeholder",
  "icu",
  "plural",
  "terminology",
];

const emptyBaseline = (): LintBaseline => ({
  placeholder: {},
  icu: {},
  plural: {},
  terminology: {},
});

/**
 * Every lint violation for one locale, keyed by category. A key appears under a
 * category when that translated string violates the corresponding check.
 */
const findViolations = (
  source: Record<string, string>,
  target: Record<string, string>,
  locale: string,
  rules: ForbiddenRule[],
): Record<LintCategory, string[]> => {
  const result: Record<LintCategory, string[]> = {
    placeholder: [],
    icu: [],
    plural: [],
    terminology: [],
  };

  for (const [key, sourceValue] of Object.entries(source)) {
    const targetValue = target[key];
    // Skip missing keys (i18n-check covers those) and untranslated values
    // (tracked as untranslated debt; their checks would be noise).
    if (targetValue === undefined || targetValue === sourceValue) {
      continue;
    }

    if (findIcuError(targetValue) !== null) {
      result.icu.push(key);
    }
    if (findPlaceholderMismatch(sourceValue, targetValue)) {
      result.placeholder.push(key);
    }
    if (findMissingPluralCategories(targetValue, locale).length > 0) {
      result.plural.push(key);
    }
    if (
      findForbiddenTerms(sourceValue, targetValue, locale, rules).length > 0
    ) {
      result.terminology.push(key);
    }
  }

  return result;
};

const isBaselined = (
  baseline: LintBaseline,
  category: LintCategory,
  key: string,
  locale: string,
): boolean => baseline[category][key]?.includes(locale) ?? false;

// --- CLI ---

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const langsDir =
      args.find((a) => !a.startsWith("--")) ??
      panic("Usage: i18n-lint <langs-dir> [--write-baseline]");
    const writeBaseline = args.includes("--write-baseline");

    const readJson = async (filePath: string): Promise<NestedMessages> => {
      const text = await Bun.file(filePath).text();
      // SAFETY: repo-owned i18n JSON conforms to NestedMessages.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return JSON.parse(text) as NestedMessages;
    };

    const source = flatten(await readJson(path.resolve(langsDir, "en.json")));
    const glossary = parseGlossary(
      await Bun.file(path.resolve(langsDir, "..", "glossary.json")).text(),
    );
    const rules = buildForbiddenRules(glossary);

    const baselinePath = path.resolve(
      langsDir,
      "..",
      "i18n-lint-baseline.json",
    );
    const readBaseline = async (): Promise<LintBaseline> => {
      const file = Bun.file(baselinePath);
      if (!(await file.exists())) {
        return emptyBaseline();
      }
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- repo-owned baseline JSON
      const parsed = JSON.parse(await file.text()) as Partial<LintBaseline>;
      return { ...emptyBaseline(), ...parsed };
    };
    const baseline = await readBaseline();

    const localeFiles = [...new Bun.Glob("*.json").scanSync(langsDir)]
      .filter((file) => file !== "en.json")
      .toSorted();

    const next = emptyBaseline();
    let hasIssues = false;

    for (const file of localeFiles) {
      const locale = file.replace(/\.json$/u, "");
      // oxlint-disable-next-line no-await-in-loop -- locales reported in sorted order
      const target = flatten(await readJson(path.resolve(langsDir, file)));
      const violations = findViolations(source, target, locale, rules);

      const reported: string[] = [];
      for (const category of CATEGORIES) {
        for (const key of violations[category]) {
          if (writeBaseline) {
            (next[category][key] ??= []).push(locale);
          } else if (!isBaselined(baseline, category, key, locale)) {
            reported.push(`  ${category}: ${key}`);
          }
        }
      }

      if (reported.length > 0) {
        hasIssues = true;
        console.log(`\n${path.resolve(langsDir, file)}:`);
        for (const line of reported.toSorted()) {
          console.log(line);
        }
      }
    }

    if (writeBaseline) {
      const sortRecord = (record: Record<string, string[]>) =>
        Object.fromEntries(
          Object.entries(record)
            .map(([key, locales]) => [key, locales.toSorted()] as const)
            .toSorted(([a], [b]) => a.localeCompare(b)),
        );
      const serialized: LintBaseline = {
        placeholder: sortRecord(next.placeholder),
        icu: sortRecord(next.icu),
        plural: sortRecord(next.plural),
        terminology: sortRecord(next.terminology),
      };
      await Bun.write(baselinePath, `${JSON.stringify(serialized, null, 2)}\n`);
      const count = CATEGORIES.reduce(
        (sum, category) =>
          sum + Object.values(next[category]).reduce((n, l) => n + l.length, 0),
        0,
      );
      console.log(
        `Wrote ${baselinePath}\n  ${count} grandfathered violations.`,
      );
    } else if (hasIssues) {
      console.log(
        "\nError: new i18n quality violations. Fix them, or grandfather with `i18n-lint <dir> --write-baseline`.",
      );
      process.exit(1);
    } else {
      console.log("No new i18n quality violations.");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
