#!/usr/bin/env bun
/**
 * Compare locale files against en.json (the source of truth).
 * Reports missing/extra keys, untranslated values (same as en), and
 * feature keys that duplicate a common.* value.
 *
 * Usage: i18n-check <langs-dir> [--sync | --write-baseline]
 *
 * --sync             Fix structural mismatches: add missing keys
 *                    (English fallback) and remove extra keys.
 * --write-baseline   Regenerate i18n-check-baseline.json, grandfathering
 *                    the current untranslated/duplicate debt so the gate
 *                    stays green while catching new regressions.
 */
import { resolve } from "node:path";

export type NestedMessages = {
  [key: string]: string | NestedMessages;
};

const flattenKeys = (obj: NestedMessages, prefix = ""): string[] => {
  const keys: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;

    if (typeof value === "string") {
      keys.push(fullKey);
    } else {
      keys.push(...flattenKeys(value, fullKey));
    }
  }

  return keys;
};

const getNestedValue = (
  obj: NestedMessages,
  keyPath: string,
): string | NestedMessages | undefined => {
  const parts = keyPath.split(".");
  let current: string | NestedMessages = obj;

  for (const part of parts) {
    if (typeof current === "string" || !(part in current)) {
      return undefined;
    }
    const next: string | NestedMessages | undefined = current[part];
    if (next === undefined) {
      return undefined;
    }
    current = next;
  }

  return current;
};

const setNestedValue = (
  obj: NestedMessages,
  keyPath: string,
  value: string | NestedMessages,
): void => {
  const parts = keyPath.split(".");
  const leaf = parts.at(-1);
  if (!leaf) {
    return;
  }

  let current: NestedMessages = obj;

  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (typeof next === "object") {
      current = next;
    } else {
      const child: NestedMessages = {};
      current[part] = child;
      current = child;
    }
  }

  current[leaf] = value;
};

const deleteNestedKey = (obj: NestedMessages, keyPath: string): void => {
  const parts = keyPath.split(".");
  const leaf = parts.at(-1);
  if (!leaf) {
    return;
  }

  const parents: { obj: NestedMessages; key: string }[] = [];
  let current: NestedMessages = obj;

  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (next === undefined || typeof next === "string") {
      return;
    }
    parents.push({ obj: current, key: part });
    current = next;
  }

  Reflect.deleteProperty(current, leaf);

  // Clean up empty parent objects bottom-up
  for (let i = parents.length - 1; i >= 0; i--) {
    const entry = parents.at(i);
    if (!entry) {
      continue;
    }
    const nested = entry.obj[entry.key];
    if (typeof nested === "object" && Object.keys(nested).length === 0) {
      Reflect.deleteProperty(entry.obj, entry.key);
    }
  }
};

/** Check whether all keys are sorted alphabetically (recursive). */
export const isSorted = (obj: NestedMessages): boolean => {
  const keys = Object.keys(obj);
  for (let i = 1; i < keys.length; i++) {
    const prev = keys[i - 1];
    const curr = keys[i];
    if (prev === undefined || curr === undefined) {
      continue;
    }
    if (prev > curr) {
      return false;
    }
  }
  return Object.values(obj).every((v) => typeof v === "string" || isSorted(v));
};

/** Recursively sort object keys alphabetically. */
export const sortKeys = (obj: NestedMessages): NestedMessages => {
  const sorted: NestedMessages = {};

  for (const key of Object.keys(obj).toSorted()) {
    const value = obj[key];
    if (value === undefined) {
      continue;
    }
    sorted[key] = typeof value === "string" ? value : sortKeys(value);
  }

  return sorted;
};

/**
 * Sync a locale object against the source (en) object.
 * Returns a new object with missing keys added (English
 * fallback), extra keys removed, and all keys sorted
 * alphabetically. Existing translations are preserved.
 */
export const syncMessages = (
  source: NestedMessages,
  target: NestedMessages,
): NestedMessages => {
  const result: NestedMessages = structuredClone(target);

  const sourceKeys = new Set(flattenKeys(source));
  const targetKeys = new Set(flattenKeys(result));

  for (const key of sourceKeys) {
    if (!targetKeys.has(key)) {
      const value = getNestedValue(source, key);
      if (value !== undefined) {
        setNestedValue(result, key, value);
      }
    }
  }

  for (const key of targetKeys) {
    if (!sourceKeys.has(key)) {
      deleteNestedKey(result, key);
    }
  }

  return sortKeys(result);
};

// --- value-level validation ---

/**
 * Baseline that grandfathers known debt so the gate stays green while
 * catching NEW regressions. `identicalToSource` maps a key to the locales
 * allowed to hold the English value; `duplicatesCommon` lists feature keys
 * allowed to repeat a `common.*` value. Burn these down over time.
 */
export type CheckBaseline = {
  identicalToSource: Record<string, string[]>;
  duplicatesCommon: string[];
};

export const emptyBaseline = (): CheckBaseline => ({
  identicalToSource: {},
  duplicatesCommon: [],
});

const HAS_LETTER = /\p{L}/u;

// Strings that are universally identical across languages: acronyms, format /
// standard tokens, and proper-noun product names. Extend sparingly — a common
// word that has real translations (e.g. "Free" -> "Gratis") does NOT belong
// here; scope intentional brand labels (e.g. DeepL "Free"/"Pro" tiers) per-key
// via the baseline instead.
const ALLOWED_IDENTICAL = new Set<string>([
  "OK",
  "API",
  "PDF",
  "CSV",
  "JSON",
  "HTML",
  "DOCX",
  "URL",
  "IBAN",
  "LEDES",
  "MCP",
  "OAuth",
  "SSO",
  "ID",
  "AI",
  "UI",
  "S3",
  "DeepL",
  "stella",
  "GitHub",
  "Google",
  "Microsoft",
  "Word",
  "Excel",
  "Markdown",
]);

/** A value that is expected to read identically in every language. */
const isTriviallyIdentical = (value: string): boolean => {
  const trimmed = value.trim();
  // Ignore ICU placeholders so "{n}" / "{value}%" count as letter-free.
  // Pattern is linear: [^}] cannot match the closing }, so no backtracking.
  // oxlint-disable-next-line sonarjs/slow-regex
  const literal = trimmed.replace(/\{[^}]*\}/gu, "");
  // Exempt only language-neutral content: no letters (numbers, punctuation,
  // placeholder-only) or an explicit allowed token. Do NOT blanket-exempt by
  // length — short words like "To"/"as" are translatable.
  return !HAS_LETTER.test(literal) || ALLOWED_IDENTICAL.has(trimmed);
};

/**
 * Keys whose locale value byte-equals the English source (untranslated),
 * excluding trivially-identical strings and baseline-grandfathered debt.
 */
export const findUntranslated = (
  source: NestedMessages,
  target: NestedMessages,
  locale: string,
  baseline: CheckBaseline,
): string[] => {
  const offenders: string[] = [];

  for (const key of flattenKeys(source)) {
    const sourceValue = getNestedValue(source, key);
    const targetValue = getNestedValue(target, key);
    if (typeof sourceValue !== "string" || sourceValue !== targetValue) {
      continue;
    }
    if (isTriviallyIdentical(sourceValue)) {
      continue;
    }
    if (baseline.identicalToSource[key]?.includes(locale)) {
      continue;
    }
    offenders.push(key);
  }

  return offenders;
};

/** Map of each `common.*` value to the first `common.*` key that holds it. */
export const buildCommonValueMap = (
  source: NestedMessages,
): Map<string, string> => {
  const map = new Map<string, string>();

  for (const key of flattenKeys(source)) {
    if (!key.startsWith("common.")) {
      continue;
    }
    const value = getNestedValue(source, key);
    if (typeof value === "string" && !map.has(value)) {
      map.set(value, key);
    }
  }

  return map;
};

/**
 * Non-`common` en.json keys whose value duplicates an existing `common.*`
 * value (and so should reuse it). Baseline grandfathers known duplicates.
 */
export const findCommonDuplicates = (
  source: NestedMessages,
  baseline: CheckBaseline,
): { key: string; reuse: string }[] => {
  const commonByValue = buildCommonValueMap(source);
  const allow = new Set(baseline.duplicatesCommon);
  const offenders: { key: string; reuse: string }[] = [];

  for (const key of flattenKeys(source)) {
    if (key.startsWith("common.") || allow.has(key)) {
      continue;
    }
    const value = getNestedValue(source, key);
    if (typeof value !== "string") {
      continue;
    }
    const reuse = commonByValue.get(value);
    if (reuse) {
      offenders.push({ key, reuse });
    }
  }

  return offenders.toSorted((a, b) => a.key.localeCompare(b.key));
};

// --- CLI ---

if (import.meta.main) {
  const args = process.argv.slice(2);
  const langsDir = args.find((a) => !a.startsWith("--"));
  const shouldSync = args.includes("--sync");
  const shouldWriteBaseline = args.includes("--write-baseline");

  if (!langsDir) {
    console.error("Usage: i18n-check <langs-dir> [--sync | --write-baseline]");
    process.exit(1);
  }

  const readLang = async (filename: string): Promise<NestedMessages> => {
    const content = await Bun.file(resolve(langsDir, filename)).text();
    // SAFETY: i18n JSON files conform to NestedMessages; script validates
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return JSON.parse(content) as NestedMessages;
  };

  const enRaw = await readLang("en.json");
  const enMessages = sortKeys(enRaw);
  const enKeys = new Set(flattenKeys(enMessages));

  // Baseline grandfathers existing untranslated/duplicate debt (kept beside
  // the langs dir so the *.json glob does not treat it as a locale).
  const baselinePath = resolve(langsDir, "..", "i18n-check-baseline.json");
  const readBaseline = async (): Promise<CheckBaseline> => {
    const file = Bun.file(baselinePath);
    if (!(await file.exists())) {
      return emptyBaseline();
    }
    // SAFETY: repo-owned baseline JSON conforms to Partial<CheckBaseline>
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const parsed = JSON.parse(await file.text()) as Partial<CheckBaseline>;
    return { ...emptyBaseline(), ...parsed };
  };
  const baseline = await readBaseline();

  const localeFiles = [...new Bun.Glob("*.json").scanSync(langsDir)]
    .filter((f) => f !== "en.json")
    .toSorted();

  // Seed/refresh the baseline from the current state, then exit.
  if (shouldWriteBaseline) {
    const identicalToSource: Record<string, string[]> = {};
    for (const file of localeFiles) {
      const locale = file.replace(/\.json$/u, "");
      const messages = await readLang(file);
      for (const key of findUntranslated(
        enMessages,
        messages,
        locale,
        emptyBaseline(),
      )) {
        (identicalToSource[key] ??= []).push(locale);
      }
    }
    const duplicatesCommon = findCommonDuplicates(
      enMessages,
      emptyBaseline(),
    ).map((o) => o.key);
    const next: CheckBaseline = {
      duplicatesCommon: duplicatesCommon.toSorted(),
      identicalToSource: Object.fromEntries(
        Object.entries(identicalToSource)
          .map(([k, v]) => [k, v.toSorted()] as const)
          .toSorted(([a], [b]) => a.localeCompare(b)),
      ),
    };
    await Bun.write(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
    const localeCount = Object.values(identicalToSource).reduce(
      (a, v) => a + v.length,
      0,
    );
    console.log(
      `Wrote ${baselinePath}\n  ${Object.keys(identicalToSource).length} untranslated keys (${localeCount} locale entries), ${duplicatesCommon.length} common-duplicate keys grandfathered.`,
    );
    process.exit(0);
  }

  let hasIssues = false;

  // Check and sort en.json
  if (!isSorted(enRaw)) {
    const enPath = resolve(langsDir, "en.json");
    console.log(`\n${enPath}:`);
    console.log("  ~ unsorted keys");
    hasIssues = true;

    if (shouldSync) {
      await Bun.write(enPath, `${JSON.stringify(enMessages, null, 2)}\n`);
      console.log("  ✓ sorted");
    }
  } else if (shouldSync) {
    // Already sorted; nothing to write
  }

  // en.json: feature keys that duplicate a common.* value (reuse it instead).
  if (!shouldSync) {
    const duplicates = findCommonDuplicates(enMessages, baseline);
    if (duplicates.length > 0) {
      hasIssues = true;
      console.log(`\n${resolve(langsDir, "en.json")}:`);
      for (const { key, reuse } of duplicates) {
        console.log(
          `  = duplicate of ${reuse}: ${key} (reuse it, or baseline it)`,
        );
      }
    }
  }

  for (const file of localeFiles) {
    const locale = file.replace(/\.json$/u, "");
    const messages = await readLang(file);
    const langKeys = new Set(flattenKeys(messages));

    const missing = [...enKeys].filter((k) => !langKeys.has(k));
    const extra = [...langKeys].filter((k) => !enKeys.has(k));
    const unsorted = !isSorted(messages);
    const untranslated = shouldSync
      ? []
      : findUntranslated(enMessages, messages, locale, baseline);

    if (
      missing.length === 0 &&
      extra.length === 0 &&
      !unsorted &&
      untranslated.length === 0
    ) {
      continue;
    }

    hasIssues = true;
    const filePath = resolve(langsDir, file);
    console.log(`\n${filePath}:`);

    for (const key of missing) {
      console.log(`  + missing: ${key}`);
    }

    for (const key of extra) {
      console.log(`  - extra:   ${key}`);
    }

    for (const key of untranslated) {
      console.log(`  = untranslated (same as en): ${key}`);
    }

    if (unsorted) {
      console.log("  ~ unsorted keys");
    }

    if (shouldSync) {
      const synced = syncMessages(enMessages, messages);
      await Bun.write(filePath, `${JSON.stringify(synced, null, 2)}\n`);
      console.log("  ✓ synced");
    }
  }

  if (!hasIssues) {
    console.log("All locale files are in sync with en.json");
  } else if (!shouldSync) {
    console.log(
      "\nError: locale files are out of sync with en.json.\n" +
        "Untranslated/duplicate findings can be fixed, or grandfathered with `i18n-check <dir> --write-baseline`.",
    );
    process.exit(1);
  }
}
