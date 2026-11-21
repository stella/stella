#!/usr/bin/env bun
/**
 * Manages domain-split web i18n catalogs under `<i18n-dir>/namespaces/<locale>/<domain>.json`
 * and assembles the merged `<i18n-dir>/langs/<locale>.json` catalogs on demand.
 *
 * Usage: i18n-namespaces <build|split|check> <i18n-dir>
 */
import { panic, Result } from "better-result";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

type JsonValue = string | JsonObject;
type JsonObject = { [key: string]: JsonValue };

export type NamespaceManifest = Record<string, string>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isJsonObject = (value: unknown): value is JsonObject =>
  isRecord(value) &&
  Object.values(value).every(
    (entry): entry is JsonValue =>
      typeof entry === "string" || isJsonObject(entry),
  );

const sortJsonObject = (obj: JsonObject): JsonObject =>
  Object.fromEntries(
    Object.keys(obj)
      .toSorted()
      .flatMap((key) => {
        const val = obj[key];
        if (val === undefined) {
          return [];
        }
        return [[key, typeof val === "string" ? val : sortJsonObject(val)]];
      }),
  );

const formatJson = (obj: JsonObject): string =>
  `${JSON.stringify(sortJsonObject(obj), null, 2)}\n`;

const writeIfChanged = async (
  filePath: string,
  content: string,
): Promise<boolean> => {
  const file = Bun.file(filePath);
  const existing = (await file.exists()) ? await file.text() : null;
  if (existing === content) {
    return false;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await Bun.write(filePath, content);
  return true;
};

export const loadManifest = async (
  i18nDir: string,
): Promise<NamespaceManifest> => {
  const manifestPath = path.join(i18nDir, "namespaces.json");
  const raw: unknown = await Bun.file(manifestPath).json();
  if (!isRecord(raw)) {
    return panic(
      `Expected ${manifestPath} to be a JSON object mapping top-level keys to domains`,
    );
  }
  const entries: [string, string][] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      !/^[a-z][a-z0-9-]*$/u.test(value)
    ) {
      return panic(
        `Invalid domain "${String(value)}" for namespace "${key}" in ${manifestPath}`,
      );
    }
    entries.push([key, value]);
  }
  return Object.fromEntries(entries);
};

export const listNamespaceLocales = async (
  i18nDir: string,
): Promise<string[]> => {
  const namespacesDir = path.join(i18nDir, "namespaces");
  const entries = await readdir(namespacesDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
};

export const checkNamespaces = async (i18nDir: string): Promise<string[]> => {
  const errors: string[] = [];
  const manifest = await loadManifest(i18nDir);
  const namespacesDir = path.join(i18nDir, "namespaces");
  const locales = await listNamespaceLocales(i18nDir);
  if (locales.length === 0) {
    return [`No locale directories found under ${namespacesDir}`];
  }
  const expectedDomains = [...new Set(Object.values(manifest))].toSorted();
  const seenNamespaces = new Set<string>();

  for (const locale of locales) {
    const localeDir = path.join(namespacesDir, locale);
    const files = (await readdir(localeDir))
      .filter((name) => name.endsWith(".json"))
      .toSorted();
    const domains = files.map((name) => name.slice(0, -5));
    const missing = expectedDomains.filter((d) => !domains.includes(d));
    const extra = domains.filter((d) => !expectedDomains.includes(d));
    if (missing.length > 0) {
      errors.push(`${locale}: missing domain file(s): ${missing.join(", ")}`);
    }
    if (extra.length > 0) {
      errors.push(`${locale}: unexpected domain file(s): ${extra.join(", ")}`);
    }

    const localeSeen = new Map<string, string>();
    for (const domain of domains) {
      const filePath = path.join(localeDir, `${domain}.json`);
      const rawText = await Bun.file(filePath).text();
      const parsedResult = Result.try<unknown>(() => JSON.parse(rawText));
      if (parsedResult.isErr()) {
        errors.push(
          `${locale}/${domain}.json: invalid JSON (${String(parsedResult.error)})`,
        );
        continue;
      }
      const parsed = parsedResult.value;
      if (!isJsonObject(parsed)) {
        errors.push(
          `${locale}/${domain}.json: expected nested object of strings`,
        );
        continue;
      }
      for (const topKey of Object.keys(parsed)) {
        if (locale === "en") {
          seenNamespaces.add(topKey);
        }
        const prevDomain = localeSeen.get(topKey);
        if (prevDomain !== undefined) {
          errors.push(
            `${locale}: duplicate top-level namespace "${topKey}" in ${prevDomain}.json and ${domain}.json`,
          );
        } else {
          localeSeen.set(topKey, domain);
        }
        const expectedDomain = manifest[topKey];
        if (expectedDomain === undefined) {
          errors.push(
            `${locale}/${domain}.json: top-level namespace "${topKey}" is not mapped in namespaces.json`,
          );
        } else if (expectedDomain !== domain) {
          errors.push(
            `${locale}/${domain}.json: top-level namespace "${topKey}" belongs in ${expectedDomain}.json according to namespaces.json`,
          );
        }
      }
    }
  }

  for (const mappedKey of Object.keys(manifest).toSorted()) {
    if (!seenNamespaces.has(mappedKey)) {
      errors.push(
        `namespaces.json: mapped namespace "${mappedKey}" is not present in en`,
      );
    }
  }

  return errors;
};

export const buildCatalogs = async (
  i18nDir: string,
): Promise<{ locales: number; written: number }> => {
  const namespacesDir = path.join(i18nDir, "namespaces");
  const langsDir = path.join(i18nDir, "langs");
  const locales = await listNamespaceLocales(i18nDir);
  let written = 0;

  for (const locale of locales) {
    const localeDir = path.join(namespacesDir, locale);
    const files = (await readdir(localeDir))
      .filter((name) => name.endsWith(".json"))
      .toSorted();
    const merged = new Map<string, JsonValue>();
    for (const fileName of files) {
      const filePath = path.join(localeDir, fileName);
      const parsed: unknown = await Bun.file(filePath).json();
      if (!isJsonObject(parsed)) {
        return panic(
          `Expected ${filePath} to contain only nested objects and strings`,
        );
      }
      for (const [key, value] of Object.entries(parsed)) {
        if (merged.has(key)) {
          return panic(
            `Duplicate top-level namespace "${key}" while building ${locale}`,
          );
        }
        merged.set(key, value);
      }
    }
    const outPath = path.join(langsDir, `${locale}.json`);
    if (await writeIfChanged(outPath, formatJson(Object.fromEntries(merged)))) {
      written++;
    }
  }

  return { locales: locales.length, written };
};

export const splitCatalogs = async (
  i18nDir: string,
): Promise<{ locales: number; written: number }> => {
  const manifest = await loadManifest(i18nDir);
  const langsDir = path.join(i18nDir, "langs");
  const namespacesDir = path.join(i18nDir, "namespaces");
  const expectedDomains = [...new Set(Object.values(manifest))].toSorted();
  const files = (await readdir(langsDir))
    .filter((name) => name.endsWith(".json"))
    .toSorted();

  let written = 0;
  for (const fileName of files) {
    const locale = fileName.slice(0, -5);
    const filePath = path.join(langsDir, fileName);
    const parsed: unknown = await Bun.file(filePath).json();
    if (!isJsonObject(parsed)) {
      return panic(
        `Expected ${filePath} to contain only nested objects and strings`,
      );
    }
    const buckets = new Map<string, Map<string, JsonValue>>();
    for (const domain of expectedDomains) {
      buckets.set(domain, new Map());
    }
    for (const [key, value] of Object.entries(parsed)) {
      const domain = manifest[key];
      if (domain === undefined) {
        return panic(
          `Top-level namespace "${key}" in ${fileName} is not mapped in namespaces.json. Add it to ${path.join(i18nDir, "namespaces.json")} first.`,
        );
      }
      const bucket = buckets.get(domain);
      if (bucket) {
        bucket.set(key, value);
      }
    }

    const localeDir = path.join(namespacesDir, locale);
    await mkdir(localeDir, { recursive: true });
    for (const [domain, data] of buckets) {
      const outPath = path.join(localeDir, `${domain}.json`);
      if (await writeIfChanged(outPath, formatJson(Object.fromEntries(data)))) {
        written++;
      }
    }

    const existing = await readdir(localeDir);
    for (const existingFile of existing) {
      if (
        existingFile.endsWith(".json") &&
        !expectedDomains.includes(existingFile.slice(0, -5))
      ) {
        await rm(path.join(localeDir, existingFile));
      }
    }
  }

  return { locales: files.length, written };
};

if (import.meta.main) {
  const [command, dirArg] = process.argv.slice(2);
  if (
    (command !== "build" && command !== "split" && command !== "check") ||
    !dirArg
  ) {
    console.error("Usage: i18n-namespaces <build|split|check> <i18n-dir>");
    process.exit(1);
  }
  const i18nDir = path.resolve(dirArg);
  if (command === "check") {
    const errors = await checkNamespaces(i18nDir);
    if (errors.length > 0) {
      for (const err of errors) {
        console.error(`Error: ${err}`);
      }
      process.exit(1);
    }
    console.log(`Namespaces under ${i18nDir} are valid.`);
  } else if (command === "build") {
    const { locales, written } = await buildCatalogs(i18nDir);
    console.log(`Built ${locales} locale catalog(s) (${written} updated).`);
  } else {
    const { locales, written } = await splitCatalogs(i18nDir);
    console.log(
      `Split ${locales} locale catalog(s) (${written} file(s) updated).`,
    );
  }
}
