#!/usr/bin/env bun
/**
 * Compare locale files against en.json (the source of truth).
 * Reports missing and extra keys per locale.
 *
 * Usage: i18n-check <langs-dir> [--sync]
 *
 * --sync  Fix mismatches: add missing keys (English fallback)
 *         and remove extra keys. Exits 0 after syncing.
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
    current = current[part];
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
    if (typeof next === "string") {
      return;
    }
    parents.push({ obj: current, key: part });
    current = next;
  }

  delete current[leaf];

  // Clean up empty parent objects bottom-up
  for (let i = parents.length - 1; i >= 0; i--) {
    const entry = parents.at(i);
    if (!entry) {
      continue;
    }
    const nested = entry.obj[entry.key];
    if (typeof nested === "object" && Object.keys(nested).length === 0) {
      delete entry.obj[entry.key];
    }
  }
};

/** Check whether all keys are sorted alphabetically (recursive). */
export const isSorted = (obj: NestedMessages): boolean => {
  const keys = Object.keys(obj);
  for (let i = 1; i < keys.length; i++) {
    if (keys[i - 1] > keys[i]) {
      return false;
    }
  }
  return Object.values(obj).every((v) => typeof v === "string" || isSorted(v));
};

/** Recursively sort object keys alphabetically. */
export const sortKeys = (obj: NestedMessages): NestedMessages => {
  const sorted: NestedMessages = {};

  for (const key of Object.keys(obj).sort()) {
    const value = obj[key];
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

// --- CLI ---

if (import.meta.main) {
  const args = process.argv.slice(2);
  const langsDir = args.find((a) => !a.startsWith("--"));
  const shouldSync = args.includes("--sync");

  if (!langsDir) {
    console.error("Usage: i18n-check <langs-dir> [--sync]");
    process.exit(1);
  }

  const readLang = async (filename: string): Promise<NestedMessages> => {
    const content = await Bun.file(resolve(langsDir, filename)).text();
    return JSON.parse(content) as NestedMessages;
  };

  const enRaw = await readLang("en.json");
  const enMessages = sortKeys(enRaw);
  const enKeys = new Set(flattenKeys(enMessages));

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

  const glob = new Bun.Glob("*.json");
  const langFiles = Array.from(glob.scanSync(langsDir))
    .filter((f) => f !== "en.json")
    .sort();

  for (const file of langFiles) {
    const messages = await readLang(file);
    const langKeys = new Set(flattenKeys(messages));

    const missing = Array.from(enKeys).filter((k) => !langKeys.has(k));
    const extra = Array.from(langKeys).filter((k) => !enKeys.has(k));
    const unsorted = !isSorted(messages);

    if (missing.length === 0 && extra.length === 0 && !unsorted) {
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
    console.log("\nError: locale files are out of sync with en.json");
    process.exit(1);
  }
}
