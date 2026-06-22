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

// Parsing ICU is the hot path (each en source is checked against every locale,
// and each value against several checks), so memoize: every unique string is
// parsed at most once. A parse failure is cached as the Error it threw.
const parseCache = new Map<string, MessageFormatElement[] | Error>();
const cachedParse = (value: string): MessageFormatElement[] | Error => {
  const cached = parseCache.get(value);
  if (cached !== undefined) {
    return cached;
  }
  let result: MessageFormatElement[] | Error;
  try {
    result = parse(value);
  } catch (error) {
    result = error instanceof Error ? error : new Error(String(error));
  }
  parseCache.set(value, result);
  return result;
};

const safeParse = (value: string): MessageFormatElement[] | null => {
  const result = cachedParse(value);
  return Array.isArray(result) ? result : null;
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
        // Rich-text tags (t.rich) are placeholders too: a dropped or renamed
        // tag breaks rendering, so track the tag name, not just its children.
        names.add(`<${element.value}>`);
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
  const result = cachedParse(value);
  return result instanceof Error ? result.message : null;
};

// CLDR lists `many` for Czech/Slovak cardinals, but it only applies to
// fractional counts (e.g. 1.5); integer UI counts use one/few/other, and
// TERMINOLOGY.md tells translators to omit it. Don't require it here.
const OMITTED_CARDINAL_PLURALS: Record<string, Set<string>> = {
  cs: new Set(["many"]),
  sk: new Set(["many"]),
};

// Resolving Intl.PluralRules is comparatively expensive and the same locale
// recurs across thousands of keys, so memoize the category list per locale+type.
const pluralCategoryCache = new Map<string, readonly string[]>();
const pluralCategories = (
  locale: string,
  type: "cardinal" | "ordinal",
): readonly string[] => {
  const cacheKey = `${locale}:${type}`;
  const cached = pluralCategoryCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const categories = new Intl.PluralRules(locale, {
    type,
  }).resolvedOptions().pluralCategories;
  pluralCategoryCache.set(cacheKey, categories);
  return categories;
};

/**
 * Plural categories the target locale requires (per CLDR) but the value omits,
 * reported as `arg#category`. Exact selectors (`=0`, `=1`) do not count, and
 * locale-specific fractional-only categories (cs/sk `many`) are not required.
 */
export const findMissingPluralCategories = (
  value: string,
  locale: string,
): string[] => {
  const ast = safeParse(value);
  if (!ast) {
    return [];
  }

  const omitted = OMITTED_CARDINAL_PLURALS[locale];
  const cardinal = pluralCategories(locale, "cardinal").filter(
    (category) => !omitted?.has(category),
  );
  const ordinal = pluralCategories(locale, "ordinal");

  const missing: string[] = [];
  const walk = (elements: MessageFormatElement[]): void => {
    for (const element of elements) {
      if (element.type === TYPE.plural) {
        const required = element.pluralType === "ordinal" ? ordinal : cardinal;
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

/** Whether a plural's branches reference its count (via `#` or `{arg}`). */
const pluralShowsCount = (
  options: Record<string, { value: MessageFormatElement[] }>,
  argName: string,
): boolean => {
  let shows = false;
  const scan = (elements: MessageFormatElement[], direct: boolean): void => {
    for (const element of elements) {
      // `#` binds to the nearest enclosing plural, so it only proves the outer
      // count is shown when found directly. Resetting `direct` for a nested
      // select too is safe: @formatjs parses `#` inside a select as a literal,
      // never a pound, so it is not counted there regardless.
      if (direct && element.type === TYPE.pound) {
        shows = true;
      }
      if (element.type === TYPE.argument && element.value === argName) {
        shows = true;
      }
      if (element.type === TYPE.plural || element.type === TYPE.select) {
        for (const option of Object.values(element.options)) {
          scan(option.value, false);
        }
      }
      if (element.type === TYPE.tag) {
        scan(element.children, direct);
      }
    }
  };
  for (const option of Object.values(options)) {
    scan(option.value, true);
  }
  return shows;
};

/** Map each plural argument to whether any of its branches shows the count. */
const collectPluralCounts = (
  elements: MessageFormatElement[],
  counts: Map<string, boolean>,
): void => {
  for (const element of elements) {
    if (element.type === TYPE.plural) {
      counts.set(
        element.value,
        (counts.get(element.value) ?? false) ||
          pluralShowsCount(element.options, element.value),
      );
    }
    if (element.type === TYPE.plural || element.type === TYPE.select) {
      for (const option of Object.values(element.options)) {
        collectPluralCounts(option.value, counts);
      }
    }
    if (element.type === TYPE.tag) {
      collectPluralCounts(element.children, counts);
    }
  }
};

/**
 * Source plural arguments the target no longer pluralizes with a visible count:
 * the plural node is gone (flattened to plain interpolation) or it kept the
 * selector but dropped the count (`#`/`{arg}`) from every branch. Placeholder
 * parity and the category check miss both, so the count silently disappears. A
 * single branch may still omit the count as long as another branch shows it.
 */
export const findDroppedPlurals = (
  source: string,
  target: string,
): string[] => {
  const sourceAst = safeParse(source);
  const targetAst = safeParse(target);
  if (!sourceAst || !targetAst) {
    return [];
  }
  const sourceCounts = new Map<string, boolean>();
  const targetCounts = new Map<string, boolean>();
  collectPluralCounts(sourceAst, sourceCounts);
  collectPluralCounts(targetAst, targetCounts);
  const dropped: string[] = [];
  for (const [arg, sourceShows] of sourceCounts) {
    if (
      !targetCounts.has(arg) ||
      (sourceShows && targetCounts.get(arg) === false)
    ) {
      dropped.push(arg);
    }
  }
  return dropped;
};

/** Exact plural selectors (`=0`, `=1`, …) per plural argument. */
const collectExactSelectors = (
  elements: MessageFormatElement[],
  byArg: Map<string, Set<string>>,
): void => {
  for (const element of elements) {
    if (element.type === TYPE.plural) {
      const exact = Object.keys(element.options).filter((key) =>
        key.startsWith("="),
      );
      if (exact.length > 0) {
        const set = byArg.get(element.value) ?? new Set<string>();
        for (const selector of exact) {
          set.add(selector);
        }
        byArg.set(element.value, set);
      }
    }
    if (element.type === TYPE.plural || element.type === TYPE.select) {
      for (const option of Object.values(element.options)) {
        collectExactSelectors(option.value, byArg);
      }
    }
    if (element.type === TYPE.tag) {
      collectExactSelectors(element.children, byArg);
    }
  }
};

/**
 * Exact plural selectors the source defines but the target dropped, reported as
 * `arg=N`. The CLDR-category check ignores exact selectors, so a translation
 * that removes the source's `=0` zero-state branch otherwise passes while count
 * 0 falls through to the generic plural category and renders the wrong copy.
 */
export const findDroppedExactSelectors = (
  source: string,
  target: string,
): string[] => {
  const sourceAst = safeParse(source);
  const targetAst = safeParse(target);
  if (!sourceAst || !targetAst) {
    return [];
  }
  const sourceExact = new Map<string, Set<string>>();
  const targetExact = new Map<string, Set<string>>();
  collectExactSelectors(sourceAst, sourceExact);
  collectExactSelectors(targetAst, targetExact);
  const dropped: string[] = [];
  for (const [arg, selectors] of sourceExact) {
    const present = targetExact.get(arg) ?? new Set<string>();
    for (const selector of selectors) {
      if (!present.has(selector)) {
        dropped.push(`${arg}${selector}`);
      }
    }
  }
  return dropped;
};

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Whole-word, script-aware (Unicode) containment test. */
const wordRegexCache = new Map<string, RegExp>();
const containsWord = (haystack: string, needle: string): boolean => {
  let regex = wordRegexCache.get(needle);
  if (!regex) {
    regex = new RegExp(`(?<!\\p{L})${escapeRegExp(needle)}(?!\\p{L})`, "iu");
    wordRegexCache.set(needle, regex);
  }
  return regex.test(haystack);
};

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

export type LintCategory = "placeholder" | "icu" | "plural" | "terminology";

export type BaselineEntry = { source: string; target: string };

// Per category: key -> locale -> the offending (source, target) pair. Tying the
// grandfather to both values means editing either the en source or the
// translation re-checks the string, so further same-category regressions on
// already-grandfathered debt are not silently allowed.
export type LintBaseline = Record<
  LintCategory,
  Record<string, Record<string, BaselineEntry>>
>;

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
    if (
      findMissingPluralCategories(targetValue, locale).length > 0 ||
      findDroppedPlurals(sourceValue, targetValue).length > 0 ||
      findDroppedExactSelectors(sourceValue, targetValue).length > 0
    ) {
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

/** A violation is suppressed only if the baselined (source, target) still matches. */
export const isSuppressed = (
  baseline: LintBaseline,
  category: LintCategory,
  key: string,
  locale: string,
  entry: BaselineEntry,
): boolean => {
  const stored = baseline[category][key]?.[locale];
  if (stored === undefined) {
    return false;
  }
  return stored.source === entry.source && stored.target === entry.target;
};

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
          const entry = {
            source: source[key] ?? "",
            target: target[key] ?? "",
          };
          if (writeBaseline) {
            (next[category][key] ??= {})[locale] = entry;
          } else if (!isSuppressed(baseline, category, key, locale, entry)) {
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

    // The en source must be valid ICU: a malformed source throws at render for
    // English users. This is a hard invariant, never grandfathered.
    if (!writeBaseline) {
      const sourceErrors = Object.entries(source)
        .filter(([, value]) => findIcuError(value) !== null)
        .map(([key]) => key)
        .toSorted();
      if (sourceErrors.length > 0) {
        hasIssues = true;
        console.log(`\n${path.resolve(langsDir, "en.json")}:`);
        for (const key of sourceErrors) {
          console.log(`  icu (source): ${key}`);
        }
      }
    }

    if (writeBaseline) {
      const sortRecord = (
        record: Record<string, Record<string, BaselineEntry>>,
      ): Record<string, Record<string, BaselineEntry>> =>
        Object.fromEntries(
          Object.entries(record)
            .toSorted(([a], [b]) => a.localeCompare(b))
            .map(([key, byLocale]) => [
              key,
              Object.fromEntries(
                Object.entries(byLocale).toSorted(([a], [b]) =>
                  a.localeCompare(b),
                ),
              ),
            ]),
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
          sum +
          Object.values(next[category]).reduce(
            (n, byLocale) => n + Object.keys(byLocale).length,
            0,
          ),
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
