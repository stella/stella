/**
 * Pure half of the house-style conversion script: its arguments and the
 * report it prints.
 *
 * The conversion itself lives in `@/api/lib/house-style/*`, which the API
 * calls too; this file owns only what a command line adds. Nothing here
 * reaches a file, a database or a network, so the report is driven directly
 * from `house-style-convert.logic.test.ts`.
 */

import { panic, Result, TaggedError } from "better-result";

import type { RenameRule } from "@/api/lib/house-style/catalogue";
import type {
  ConversionRow,
  ConversionSummary,
} from "@/api/lib/house-style/convert";

export class HouseStyleArgumentError extends TaggedError(
  "HouseStyleArgumentError",
)<{ message: string }> {}

export const USAGE = `Usage: bun --env-file=.env src/scripts/house-style-convert.ts [options]

  --house <docx>            The style set: the document whose styles are the house style.
  --write-catalogue <json>  Write the house style's catalogue and exit.
  --input <docx>            The document to convert.
  --guide <json>            The style guide: { "styles": [{ id, name, purpose, … }] }.
  --out <docx>              Where to write the converted document.
  --report <json>           Write the per-paragraph mapping and the run's numbers.
  --rename <from>=<to>      Rewrite a substring in every style id and name (repeatable).
  --limit <n>               Paragraphs put to the decision model; the rest take the rule.
  --dry-run                 Convert but write no document.
  --help                    Print this and exit.

Needs TYPESAFE_API_KEY for the decision tier; without it every paragraph
takes the rule tier and the conversion still runs.`;

const VALUE_FLAGS = [
  "house",
  "write-catalogue",
  "input",
  "guide",
  "out",
  "report",
  "limit",
] as const;
const REPEATABLE_FLAGS = ["rename"] as const;
const TOGGLE_FLAGS = ["dry-run", "help"] as const;

const DECIMAL_INTEGER = /^\d+$/u;

const invalid = (message: string): Result<never, HouseStyleArgumentError> =>
  Result.err(new HouseStyleArgumentError({ message }));

type RepeatableFlag = (typeof REPEATABLE_FLAGS)[number];

type FlagSet = {
  values: Map<string, string>;
  /** Seeded with every repeatable flag, so a miss is a programming error. */
  repeated: Map<RepeatableFlag, string[]>;
  toggles: Set<string>;
};

const repeatedValues = (
  repeated: FlagSet["repeated"],
  flag: RepeatableFlag,
): string[] =>
  repeated.get(flag) ?? panic("a repeatable flag was never seeded", { flag });

/**
 * Strict `--flag value`: an unknown flag, a positional argument or a repeat
 * of a single-valued flag fails rather than being ignored, so a typo cannot
 * silently convert against a default it was not asked for.
 */
const parseFlags = (
  argv: readonly string[],
): Result<FlagSet, HouseStyleArgumentError> => {
  const values = new Map<string, string>();
  const repeated = new Map<RepeatableFlag, string[]>(
    REPEATABLE_FLAGS.map((flag) => [flag, []]),
  );
  const toggles = new Set<string>();
  let index = 0;
  while (index < argv.length) {
    const token = argv.at(index);
    if (token === undefined || !token.startsWith("--")) {
      return invalid(`unexpected argument: ${String(token)}`);
    }
    const name = token.slice(2);
    if (TOGGLE_FLAGS.some((known) => known === name)) {
      if (toggles.has(name)) {
        return invalid(`${token} was given more than once`);
      }
      toggles.add(name);
      index += 1;
      continue;
    }
    const repeatable = REPEATABLE_FLAGS.find((known) => known === name);
    if (
      repeatable === undefined &&
      !VALUE_FLAGS.some((known) => known === name)
    ) {
      return invalid(`unknown option: ${token}`);
    }
    const value = argv.at(index + 1);
    if (value === undefined || value.startsWith("--")) {
      return invalid(`${token} requires a value`);
    }
    if (repeatable !== undefined) {
      repeatedValues(repeated, repeatable).push(value);
    } else {
      if (values.has(name)) {
        return invalid(`${token} was given more than once`);
      }
      values.set(name, value);
    }
    index += 2;
  }
  return Result.ok({ values, repeated, toggles });
};

export const parseRenameRules = (
  raw: readonly string[],
): Result<RenameRule[], HouseStyleArgumentError> => {
  const rules: RenameRule[] = [];
  for (const entry of raw) {
    const separator = entry.indexOf("=");
    const from = separator === -1 ? "" : entry.slice(0, separator);
    const to = separator === -1 ? "" : entry.slice(separator + 1);
    if (from.length === 0 || to.length === 0) {
      return invalid(`--rename must read <from>=<to>, got: ${entry}`);
    }
    rules.push({ from, to });
  }
  return Result.ok(rules);
};

export type CatalogueCommand = {
  type: "catalogue";
  house: string;
  cataloguePath: string;
  rename: RenameRule[];
};

export type ConvertCommand = {
  type: "convert";
  house: string;
  input: string;
  guide: string;
  /** Null under `--dry-run`: the conversion runs and nothing is written. */
  out: string | null;
  report: string | null;
  limit: number | null;
  rename: RenameRule[];
};

export type HouseStyleCommand =
  | { type: "help" }
  | CatalogueCommand
  | ConvertCommand;

export const parseConvertArgs = (
  argv: readonly string[],
): Result<HouseStyleCommand, HouseStyleArgumentError> => {
  const flags = parseFlags(argv);
  if (Result.isError(flags)) {
    return flags;
  }
  const { values, repeated, toggles } = flags.value;
  if (toggles.has("help")) {
    return Result.ok({ type: "help" });
  }
  const rename = parseRenameRules(repeatedValues(repeated, "rename"));
  if (Result.isError(rename)) {
    return rename;
  }
  const house = values.get("house");
  if (house === undefined) {
    return invalid(
      "--house names the document whose styles are the house style",
    );
  }

  const cataloguePath = values.get("write-catalogue");
  if (cataloguePath !== undefined) {
    return Result.ok({
      type: "catalogue",
      house,
      cataloguePath,
      rename: rename.value,
    });
  }

  const input = values.get("input");
  const guide = values.get("guide");
  if (input === undefined || guide === undefined) {
    return invalid(
      "--input and --guide are required; --write-catalogue writes the catalogue a guide is authored from",
    );
  }
  const dryRun = toggles.has("dry-run");
  const out = values.get("out") ?? null;
  if (out === null && !dryRun) {
    return invalid("--out is required unless --dry-run is given");
  }
  const rawLimit = values.get("limit");
  if (rawLimit !== undefined && !DECIMAL_INTEGER.test(rawLimit)) {
    return invalid(`--limit must be a positive integer, got: ${rawLimit}`);
  }
  const limit = rawLimit === undefined ? null : Number.parseInt(rawLimit, 10);
  if (limit !== null && limit <= 0) {
    return invalid(
      `--limit must be a positive integer, got: ${rawLimit ?? ""}`,
    );
  }
  return Result.ok({
    type: "convert",
    house,
    input,
    guide,
    out: dryRun ? null : out,
    report: values.get("report") ?? null,
    limit,
    rename: rename.value,
  });
};

/** Text as one table cell: no line breaks, bounded width. */
const cell = (text: string, width: number): string => {
  const flat = text.replaceAll(/\s+/gu, " ").trim();
  const points = Array.from(flat);
  const shortened =
    points.length <= width ? flat : `${points.slice(0, width - 1).join("")}…`;
  return shortened.padEnd(width, " ");
};

const probability = (value: number | null): string =>
  value === null ? "—" : value.toFixed(2);

const ms = (value: number | null): string =>
  value === null ? "—" : `${value.toFixed(0)} ms`;

export type RenderConversionReportOptions = {
  rows: readonly ConversionRow[];
  summary: ConversionSummary;
};

export const renderConversionReport = ({
  rows,
  summary,
}: RenderConversionReportOptions): string => {
  const lines = [
    `${cell("#", 4)} ${cell("was", 22)} ${cell("became", 22)} ${cell("p", 5)} ${cell("tier", 15)} text`,
  ];
  for (const row of rows) {
    lines.push(
      `${cell(String(row.index), 4)} ${cell(row.originalStyleName, 22)} ${cell(row.styleId, 22)} ${cell(probability(row.probability), 5)} ${cell(row.tier, 15)} ${cell(row.snippet, 70)}`,
    );
  }
  lines.push(
    "",
    `paragraphs: ${String(summary.paragraphs)}`,
    `decided by the model: ${String(summary.byTier["decision-model"])}, by the rule: ${String(summary.byTier.rule)}`,
    `empty paragraphs dropped: ${String(summary.droppedEmptyParagraphs)}, manual numbers stripped: ${String(summary.strippedManualMarkers)}`,
    `requests: ${String(summary.requests)}, input tokens: ${String(summary.inputTokens)}, cost: $${summary.usd.toFixed(4)}`,
    `latency p50 ${ms(summary.latencyP50Ms)}, p95 ${ms(summary.latencyP95Ms)}`,
    `model: ${summary.model ?? "none — every paragraph took the rule tier"}`,
    "",
    "per house style:",
  );
  for (const style of summary.byStyle) {
    lines.push(
      `  ${cell(style.styleId, 24)} ${cell(style.name, 28)} ${String(style.count)}`,
    );
  }
  return lines.join("\n");
};
