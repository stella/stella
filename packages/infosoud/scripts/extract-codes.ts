import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT_URL = "https://infosoud.gov.cz/";
const OUTPUT_PATH = resolve(
  import.meta.dir,
  "../src/code-catalog.generated.ts",
);
const DISCOVERY_MAX_ASSETS = 200;
const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT =
  "infosoud-code-catalog/0.1.0 (+https://github.com/stella/stella/tree/main/packages/infosoud)";

type ExtractOptions = {
  readonly bundleUrl?: string | undefined;
  readonly check?: boolean | undefined;
};

type CodeCatalog = {
  readonly attributeLabelOverrides: Record<string, Record<string, string>>;
  readonly attributeLabels: Record<string, string>;
  readonly bundleUrl: string;
  readonly eventDescriptionOverrides: Record<string, Record<string, string>>;
  readonly eventDescriptions: Record<string, string>;
  readonly eventLabelOverrides: Record<string, Record<string, string>>;
  readonly eventLabels: Record<string, string>;
  readonly eventTooltipOverrides: Record<string, Record<string, string>>;
  readonly eventTooltips: Record<string, string>;
};

type PlainRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is PlainRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sortRecord = (value: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(value).toSorted(([left], [right]) =>
      left.localeCompare(right),
    ),
  );

const parseArgs = (args: readonly string[]): ExtractOptions => {
  let bundleUrl: string | undefined;
  let check = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--check") {
      check = true;
      continue;
    }

    if (argument === "--bundle-url") {
      const next = args[index + 1];
      if (!next) {
        throw new TypeError("--bundle-url requires a value");
      }

      bundleUrl = next;
      index += 1;
      continue;
    }

    throw new TypeError(`Unknown argument: ${argument}`);
  }

  return { bundleUrl, check };
};

const fetchText = async (url: string): Promise<string> => {
  const response = await fetch(url, {
    headers: {
      "user-agent": USER_AGENT,
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status}`);
  }

  return response.text();
};

const extractJavaScriptUrls = (html: string): string[] =>
  Array.from(
    new Set(
      Array.from(
        html.matchAll(/(?:src|href)="([^"]+\.js(?:\?[^"]*)?)"/g),
        (match) => {
          const url = match[1];
          if (!url) {
            throw new TypeError("Matched script URL was unexpectedly empty");
          }

          return new URL(url, ROOT_URL).toString();
        },
      ),
    ),
  );

const extractChunkUrls = (scriptText: string): string[] =>
  Array.from(
    new Set(
      Array.from(scriptText.matchAll(/chunk-[A-Z0-9]+\.js/g), ([chunk]) =>
        new URL(chunk, ROOT_URL).toString(),
      ),
    ),
  );

const discoverCatalogBundleUrl = async (): Promise<string> => {
  const html = await fetchText(ROOT_URL);
  const queue = extractJavaScriptUrls(html);
  const seen = new Set<string>();

  while (queue.length > 0) {
    const candidate = queue.shift();
    if (!candidate || seen.has(candidate)) {
      continue;
    }

    seen.add(candidate);
    if (seen.size > DISCOVERY_MAX_ASSETS) {
      break;
    }

    const scriptText = await fetchText(candidate);
    if (
      scriptText.includes("udalost:{") &&
      scriptText.includes("atribut:{") &&
      scriptText.includes('JED_D_ZAC:"')
    ) {
      return candidate;
    }

    for (const chunkUrl of extractChunkUrls(scriptText)) {
      if (!seen.has(chunkUrl)) {
        queue.push(chunkUrl);
      }
    }
  }

  throw new Error(
    `Could not discover the InfoSoud code catalog bundle from ${ROOT_URL}`,
  );
};

const extractObjectLiteral = (scriptText: string, prefix: string): string => {
  const prefixIndex = scriptText.indexOf(prefix);
  if (prefixIndex === -1) {
    throw new Error(`Could not find ${prefix} in bundle`);
  }

  const startIndex = scriptText.indexOf("{", prefixIndex);
  if (startIndex === -1) {
    throw new Error(`Could not locate object start for ${prefix}`);
  }

  let depth = 0;
  let endIndex = -1;
  for (let index = startIndex; index < scriptText.length; index += 1) {
    const character = scriptText[index];
    if (character === "{") {
      depth += 1;
      continue;
    }

    if (character !== "}") {
      continue;
    }

    depth -= 1;
    if (depth === 0) {
      endIndex = index;
      break;
    }
  }

  if (endIndex === -1) {
    throw new Error(`Could not locate object end for ${prefix}`);
  }

  return scriptText.slice(startIndex, endIndex + 1);
};

const normalizeJavaScriptStrings = (literal: string): string => {
  let result = "";
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < literal.length; index += 1) {
    const character = literal[index];

    if (quote === null) {
      if (character === "'" || character === '"') {
        quote = character;
        result += '"';
        continue;
      }

      result += character;
      continue;
    }

    if (character === "\\") {
      const next = literal[index + 1];
      if (!next) {
        throw new Error("Unexpected trailing escape in bundle object literal");
      }

      if (next === "x") {
        const hex = literal.slice(index + 2, index + 4);
        if (hex.length !== 2) {
          throw new Error("Invalid hex escape in bundle object literal");
        }

        result += `\\u00${hex}`;
        index += 3;
        continue;
      }

      if (next === "u") {
        const unicode = literal.slice(index + 2, index + 6);
        if (unicode.length !== 4) {
          throw new Error("Invalid unicode escape in bundle object literal");
        }

        result += `\\u${unicode}`;
        index += 5;
        continue;
      }

      if (quote === "'" && next === "'") {
        result += "'";
        index += 1;
        continue;
      }

      if (next === '"') {
        result += '\\"';
        index += 1;
        continue;
      }

      if (next === "\\") {
        result += "\\\\";
        index += 1;
        continue;
      }

      result += `\\${next}`;
      index += 1;
      continue;
    }

    if (character === quote) {
      quote = null;
      result += '"';
      continue;
    }

    if (character === '"') {
      result += '\\"';
      continue;
    }

    result += character;
  }

  if (quote !== null) {
    throw new Error("Unterminated string in bundle object literal");
  }

  return result;
};

const toJsonObjectLiteral = (literal: string): string =>
  normalizeJavaScriptStrings(literal).replaceAll(
    /([{,]\s*)([A-Za-z_][A-Za-z0-9_]*):/g,
    (_match, prefix: string, key: string) => `${prefix}"${key}":`,
  );

const parseCatalogObject = (
  scriptText: string,
  prefix: string,
): PlainRecord => {
  const literal = extractObjectLiteral(scriptText, prefix);
  const parsed: unknown = JSON.parse(toJsonObjectLiteral(literal));
  if (!isRecord(parsed)) {
    throw new TypeError(`${prefix} did not evaluate to an object`);
  }

  return parsed;
};

const collectTopLevelStringEntries = (
  value: PlainRecord,
): Record<string, string> => {
  const entries: Record<string, string> = {};

  for (const [key, entryValue] of Object.entries(value)) {
    if (!/^[A-Z][A-Z0-9_]{2,}$/.test(key) || typeof entryValue !== "string") {
      continue;
    }

    entries[key] = entryValue;
  }

  return sortRecord(entries);
};

const collectNestedStringEntries = (
  value: PlainRecord,
  key: string,
): Record<string, string> => {
  const nested = value[key];
  if (!isRecord(nested)) {
    return {};
  }

  return collectTopLevelStringEntries(nested);
};

const collectScopedStringEntries = (
  value: PlainRecord,
): Record<string, Record<string, string>> => {
  const scopedEntries: [string, Record<string, string>][] = [];

  for (const [key, entryValue] of Object.entries(value)) {
    if (!/^[a-z]{2,3}$/.test(key) || !isRecord(entryValue)) {
      continue;
    }

    const scopedValues = collectTopLevelStringEntries(entryValue);
    if (Object.keys(scopedValues).length === 0) {
      continue;
    }

    scopedEntries.push([key, scopedValues]);
  }

  scopedEntries.sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(scopedEntries);
};

const collectScopedNestedStringEntries = (
  value: PlainRecord,
  key: string,
): Record<string, Record<string, string>> => {
  const scopedEntries: [string, Record<string, string>][] = [];

  for (const [scope, scopeValue] of Object.entries(value)) {
    if (!/^[a-z]{2,3}$/.test(scope) || !isRecord(scopeValue)) {
      continue;
    }

    const scopedValues = collectNestedStringEntries(scopeValue, key);
    if (Object.keys(scopedValues).length === 0) {
      continue;
    }

    scopedEntries.push([scope, scopedValues]);
  }

  scopedEntries.sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(scopedEntries);
};

const renderStringRecord = (
  value: Record<string, string>,
  indent: string,
): string => {
  const lines = ["{"];

  for (const [key, label] of Object.entries(value)) {
    lines.push(`${indent}  ${key}: ${JSON.stringify(label)},`);
  }

  lines.push(`${indent}}`);
  return lines.join("\n");
};

const renderNestedStringRecord = (
  value: Record<string, Record<string, string>>,
  indent: string,
): string => {
  const lines = ["{"];

  for (const [scope, scopedValues] of Object.entries(value)) {
    lines.push(
      `${indent}  ${scope}: ${renderStringRecord(scopedValues, `${indent}  `)},`,
    );
  }

  lines.push(`${indent}}`);
  return lines.join("\n");
};

const renderCatalogFile = ({
  attributeLabelOverrides,
  attributeLabels,
  bundleUrl,
  eventDescriptionOverrides,
  eventDescriptions,
  eventLabelOverrides,
  eventLabels,
  eventTooltipOverrides,
  eventTooltips,
}: CodeCatalog): string =>
  [
    "// Generated by ./scripts/extract-codes.ts from the public InfoSoud frontend bundle.",
    "// Do not edit manually.",
    "",
    `export const INFO_SOUD_CODE_CATALOG_SOURCE_PAGE_URL = ${JSON.stringify(ROOT_URL)};`,
    `export const INFO_SOUD_CODE_CATALOG_SOURCE_BUNDLE_URL = ${JSON.stringify(bundleUrl)};`,
    "",
    `export const INFO_SOUD_EVENT_LABELS = ${renderStringRecord(eventLabels, "")} as const;`,
    "",
    `export const INFO_SOUD_EVENT_LABEL_OVERRIDES = ${renderNestedStringRecord(eventLabelOverrides, "")} as const;`,
    "",
    `export const INFO_SOUD_EVENT_TOOLTIPS = ${renderStringRecord(eventTooltips, "")} as const;`,
    "",
    `export const INFO_SOUD_EVENT_TOOLTIP_OVERRIDES = ${renderNestedStringRecord(eventTooltipOverrides, "")} as const;`,
    "",
    `export const INFO_SOUD_EVENT_DESCRIPTIONS = ${renderStringRecord(eventDescriptions, "")} as const;`,
    "",
    `export const INFO_SOUD_EVENT_DESCRIPTION_OVERRIDES = ${renderNestedStringRecord(eventDescriptionOverrides, "")} as const;`,
    "",
    `export const INFO_SOUD_ATTRIBUTE_LABELS = ${renderStringRecord(attributeLabels, "")} as const;`,
    "",
    `export const INFO_SOUD_ATTRIBUTE_LABEL_OVERRIDES = ${renderNestedStringRecord(attributeLabelOverrides, "")} as const;`,
    "",
  ].join("\n");

const loadCatalog = async (options: ExtractOptions): Promise<CodeCatalog> => {
  const bundleUrl = options.bundleUrl ?? (await discoverCatalogBundleUrl());
  const scriptText = await fetchText(bundleUrl);
  const eventCatalog = parseCatalogObject(scriptText, "udalost:");
  const attributeCatalog = parseCatalogObject(scriptText, "atribut:");

  return {
    attributeLabelOverrides: collectScopedStringEntries(attributeCatalog),
    attributeLabels: collectTopLevelStringEntries(attributeCatalog),
    bundleUrl,
    eventDescriptionOverrides: collectScopedNestedStringEntries(
      eventCatalog,
      "popis",
    ),
    eventDescriptions: collectNestedStringEntries(eventCatalog, "popis"),
    eventLabelOverrides: collectScopedStringEntries(eventCatalog),
    eventLabels: collectTopLevelStringEntries(eventCatalog),
    eventTooltipOverrides: collectScopedNestedStringEntries(
      eventCatalog,
      "tooltip",
    ),
    eventTooltips: collectNestedStringEntries(eventCatalog, "tooltip"),
  };
};

const main = async (): Promise<void> => {
  const options = parseArgs(Bun.argv.slice(2));
  const catalog = await loadCatalog(options);
  const nextContents = renderCatalogFile(catalog);

  if (options.check) {
    const currentContents = await readFile(OUTPUT_PATH, "utf-8");
    if (currentContents !== nextContents) {
      throw new Error(
        `Code catalog is stale. Refresh it with: bun scripts/extract-codes.ts`,
      );
    }

    console.log(`InfoSoud code catalog is up to date (${catalog.bundleUrl}).`);
    return;
  }

  await mkdir(resolve(import.meta.dir, "../src"), { recursive: true });
  await writeFile(OUTPUT_PATH, nextContents);
  console.log(`Wrote ${OUTPUT_PATH}`);
  console.log(`Source bundle: ${catalog.bundleUrl}`);
};

await main();
