// Output layer (spec 051 S4). Every response is parsed as
// `JSON.parse(content[0].text)` upstream; here we pick the render shape as a
// discriminated union (page envelope / single object / windowed text / raw
// text) and render it as a table (default on a TTY) or pretty JSON (default off
// a TTY), honoring `--output`/`--json`/`--table`. `nextCursor` hints and `--all`
// truncation notices go to stderr so a piped JSON stdout stays clean.

import { panic } from "better-result";

import { EXIT_CODES, type ExitCode } from "./mcp-constants.js";
import type { CompositeView } from "./route-types.js";

export type OutputFormat = "json" | "table" | "jsonl";

/** Reserved output flags read off a parsed command's flags. */
export type OutputFlags = {
  output?: OutputFormat | undefined;
  json?: boolean | undefined;
  table?: boolean | undefined;
};

export const selectFormat = ({
  flags,
  isTTY,
}: {
  flags: OutputFlags;
  isTTY: boolean;
}): OutputFormat => {
  if (flags.output !== undefined) {
    return flags.output;
  }
  if (flags.json === true) {
    return "json";
  }
  if (flags.table === true) {
    return "table";
  }
  return isTTY ? "table" : "json";
};

/**
 * Render one JSON value as a single JSONL line (spec 049 §3). Objects and
 * scalars alike collapse to one compact line on stdout.
 */
export const jsonlLine = (value: unknown): string =>
  `${JSON.stringify(value)}\n`;

/** The mutually exclusive render shapes (spec S4). */
export type RenderPlan =
  | {
      kind: "page";
      itemsKey: string;
      items: readonly unknown[];
      payload: unknown;
      nextCursor: string | null;
      columns: readonly string[] | undefined;
    }
  | { kind: "single"; payload: unknown }
  /** One record holding tables; see `ToolAnnotation.composite`. */
  | { kind: "composite"; payload: unknown; view: CompositeView }
  | {
      kind: "windowed-text";
      text: string;
      nextCursor: string | null;
      url?: string | null;
      source_url?: string;
    }
  /** A windowed-text read whose response holds no text; see `TEXT_UNAVAILABLE_REASONS`. */
  | {
      kind: "text-unavailable";
      reason: TextUnavailableReason;
      textPath: string;
      payload: unknown;
    }
  | { kind: "raw-text"; text: string };

/**
 * Why a windowed-text read printed no text. A closed set, emitted under
 * `--json` as `textUnavailable.reason` beside `text: null`, so a script tells
 * "no text" from "empty text" without parsing a message:
 * - `no_text`: the server answered and stated there is no text (`null` at the
 *   leaf's text path). The response's own fields say why (a withheld or
 *   unavailable reason), so the whole response is kept beside the outcome.
 * - `not_in_response`: the response carries nothing at the path this command
 *   reads its text from. The command was built for a different response shape
 *   than the server sent, usually an older CLI against a newer server.
 */
export const TEXT_UNAVAILABLE_REASONS = {
  noText: "no_text",
  notInResponse: "not_in_response",
} as const;

type TextUnavailableReason =
  (typeof TEXT_UNAVAILABLE_REASONS)[keyof typeof TEXT_UNAVAILABLE_REASONS];

/**
 * The exit class of a rendered plan, when the plan itself decides one.
 * `no_text` is an answer, so it exits 0 like every other outcome the server
 * types per subject (a batch read's `not_found` entry exits 0 too).
 * `not_in_response` means the CLI could not read the response it got: the
 * documented "unexpected" class, never a silent success.
 */
export const renderPlanExitCode = (plan: RenderPlan): ExitCode | undefined => {
  if (plan.kind !== "text-unavailable") {
    return undefined;
  }
  switch (plan.reason) {
    case TEXT_UNAVAILABLE_REASONS.noText: {
      return EXIT_CODES.ok;
    }
    case TEXT_UNAVAILABLE_REASONS.notInResponse: {
      return EXIT_CODES.unexpected;
    }
    default: {
      plan.reason satisfies never;
      return panic("Unhandled text-unavailable reason");
    }
  }
};

const textUnavailableMessage = (
  reason: TextUnavailableReason,
  textPath: string,
): string => {
  switch (reason) {
    case TEXT_UNAVAILABLE_REASONS.noText: {
      return `No text: the server states none for this read (\`${textPath}\` is null); the response fields say why.`;
    }
    case TEXT_UNAVAILABLE_REASONS.notInResponse: {
      return `No text: the response has nothing at \`${textPath}\`, so this command expects a different response shape than the server sent. Upgrade with: npm i -g @stll/cli`;
    }
    default: {
      reason satisfies never;
      return panic("Unhandled text-unavailable reason");
    }
  }
};

/** The `--json` / JSONL shape of a read that has no text to print. */
const textUnavailableEnvelope = (
  plan: Extract<RenderPlan, { kind: "text-unavailable" }>,
) => ({
  text: null,
  textUnavailable: { reason: plan.reason, textPath: plan.textPath },
  response: plan.payload,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const arrayAt = (payload: unknown, key: string): readonly unknown[] | null => {
  if (!isRecord(payload)) {
    return null;
  }
  const value = payload[key];
  return Array.isArray(value) ? value : null;
};

const fieldOf = (payload: unknown, key: string): unknown =>
  isRecord(payload) ? payload[key] : undefined;

/**
 * The path `--all` merges concatenated windows back to. A merged payload is
 * the CLI's own shape, not the tool's, so the two sites that build and read
 * it name the same constant rather than both spelling `"text"`.
 */
export const MERGED_TEXT_PATH = "text";

/**
 * One value at a dot-separated path (`statute.text`). A read that nests its
 * subject (`{ statute: { text } }`) is as ordinary as one that does not, and
 * a missing segment is an absent value rather than a throw.
 */
export const valueAtPath = (payload: unknown, path: string): unknown => {
  let current: unknown = payload;
  for (const key of path.split(".")) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
};

/**
 * Choose the render shape for a parsed payload given the leaf's annotations and
 * whether a single-read flip is active for this invocation (spec S4).
 */
export const buildRenderPlan = ({
  payload,
  itemsKey,
  textPath,
  singleReadActive,
  columns,
  composite,
}: {
  payload: unknown;
  itemsKey: string | undefined;
  /** Set exactly for a windowed-text leaf; see `LeafCommandSpec.textPath`. */
  textPath: string | undefined;
  singleReadActive: boolean;
  columns: readonly string[] | undefined;
  composite?: CompositeView | undefined;
}): RenderPlan => {
  if (textPath !== undefined) {
    const text = valueAtPath(payload, textPath);
    // Only a string is text. Anything else printed as "" would read as a
    // document that is empty, which is the one answer a missing or withheld
    // text must never look like.
    if (typeof text !== "string") {
      return {
        kind: "text-unavailable",
        reason:
          text === null
            ? TEXT_UNAVAILABLE_REASONS.noText
            : TEXT_UNAVAILABLE_REASONS.notInResponse,
        textPath,
        payload,
      };
    }
    const containerPath = textPath.slice(
      0,
      Math.max(0, textPath.lastIndexOf(".")),
    );
    const container =
      containerPath === "" ? payload : valueAtPath(payload, containerPath);
    const url = fieldOf(container, "url");
    const sourceUrl = fieldOf(container, "source_url");
    return {
      kind: "windowed-text",
      ...(typeof url === "string" || url === null ? { url } : {}),
      ...(typeof sourceUrl === "string" ? { source_url: sourceUrl } : {}),
      text,
      nextCursor: asString(fieldOf(payload, "nextCursor")),
    };
  }
  // Another outcome of the same tool (one without the tables) is one record.
  if (
    composite !== undefined &&
    arrayAt(payload, rowsRootKey(composite.sections[0].rows)) !== null
  ) {
    return { kind: "composite", payload, view: composite };
  }
  if (!singleReadActive && itemsKey !== undefined) {
    const items = arrayAt(payload, itemsKey);
    if (items !== null) {
      return {
        kind: "page",
        itemsKey,
        items,
        payload,
        nextCursor: asString(fieldOf(payload, "nextCursor")),
        columns,
      };
    }
  }
  return { kind: "single", payload };
};

/** The top-level key a composite section's rows path starts from. */
const rowsRootKey = (rows: string): string =>
  (rows.split(".").at(0) ?? rows).replace(/\[\]$/u, "");

type GatheredRow = { row: unknown; parent: unknown };

/**
 * The records at a composite section's `rows` path, each with the record it
 * was read from. A `[]` segment spreads an array, so `lists[].possibleMatches`
 * yields every list's matches, each beside its list.
 */
const gatherRows = (payload: unknown, rows: string): GatheredRow[] => {
  const segments = rows.split(".");
  const last = (segments.pop() ?? rows).replace(/\[\]$/u, "");
  let holders: readonly unknown[] = [payload];
  for (const segment of segments) {
    holders = segment.endsWith("[]")
      ? holders.flatMap((holder) => {
          // A holder without the array (a list that failed) adds no rows.
          const spread = arrayAt(holder, segment.slice(0, -2));
          if (spread === null) {
            return [];
          }
          return spread;
        })
      : holders.map((holder) => fieldOf(holder, segment));
  }
  return holders.flatMap((holder) => {
    const found = arrayAt(holder, last);
    return found === null ? [] : found.map((row) => ({ row, parent: holder }));
  });
};

/** A composite column read from the record a row was gathered from. */
const PARENT_PREFIX = "^.";

const columnHeader = (column: string): string =>
  column.startsWith(PARENT_PREFIX)
    ? column.slice(PARENT_PREFIX.length)
    : column;

const columnValue = ({ row, parent }: GatheredRow, column: string): unknown =>
  column.startsWith(PARENT_PREFIX)
    ? valueAtPath(parent, column.slice(PARENT_PREFIX.length))
    : valueAtPath(row, column);

const isScalar = (value: unknown): value is string | number | boolean =>
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean";

const formatCell = (value: unknown): string => {
  if (value === null || value === undefined) {
    return "";
  }
  if (isScalar(value)) {
    return String(value);
  }
  if (Array.isArray(value) && value.every(isScalar)) {
    return value.map(String).join(", ");
  }
  return JSON.stringify(value);
};

const MIN_COLUMN_WIDTH = 8;
const COLUMN_GUTTER = 2;
const ELLIPSIS = "\u2026";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** East Asian wide and fullwidth forms, and pictographic emoji: two terminal cells. */
const WIDE_GRAPHEME =
  /^[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{20000}-\u{3FFFD}]/u;
/** Combining marks alone take no cell; so do the joiners and the emoji variation selector. */
const COMBINING_MARKS = /^\p{M}+$/u;
const ZERO_WIDTH_CODE_POINTS: ReadonlySet<number> = new Set([
  0x20_0b, 0x20_0c, 0x20_0d, 0xfe_0f,
]);

const isZeroWidth = (grapheme: string): boolean => {
  if (COMBINING_MARKS.test(grapheme)) {
    return true;
  }
  for (const char of grapheme) {
    if (!ZERO_WIDTH_CODE_POINTS.has(char.codePointAt(0) ?? -1)) {
      return false;
    }
  }
  return true;
};

const graphemeWidth = (grapheme: string): number => {
  if (isZeroWidth(grapheme)) {
    return 0;
  }
  return WIDE_GRAPHEME.test(grapheme) ? 2 : 1;
};

/**
 * Terminal cells a string occupies. UTF-16 length is wrong for CJK (two cells
 * per character), emoji (surrogate pairs, one or two cells) and combining
 * marks (zero), all of which appear in legal names and document titles.
 */
export const displayWidth = (text: string): number => {
  let width = 0;
  for (const { segment } of graphemes.segment(text)) {
    width += graphemeWidth(segment);
  }
  return width;
};

/** Cut on grapheme boundaries so a surrogate pair or a mark is never split. */
const truncate = (text: string, width: number): string => {
  if (displayWidth(text) <= width) {
    return text;
  }
  const budget = Math.max(width - 1, 1);
  let out = "";
  let used = 0;
  for (const { segment } of graphemes.segment(text)) {
    const cells = graphemeWidth(segment);
    if (used + cells > budget) {
      break;
    }
    out += segment;
    used += cells;
  }
  return `${out}${ELLIPSIS}`;
};

const padToWidth = (text: string, width: number): string =>
  `${text}${" ".repeat(Math.max(width - displayWidth(text), 0))}`;

/**
 * Shrink the widest columns first until one row fits `width`; a column never
 * drops below `MIN_COLUMN_WIDTH`, so a very narrow terminal still shows every
 * column and the reader scrolls instead of losing one.
 */
const fitWidths = (
  natural: readonly number[],
  width: number | undefined,
): number[] => {
  const fitted = [...natural];
  if (width === undefined) {
    return fitted;
  }
  let total =
    fitted.reduce((sum, columnWidth) => sum + columnWidth, 0) +
    COLUMN_GUTTER * (fitted.length - 1);
  while (total > width) {
    const widest = Math.max(...fitted);
    if (widest <= MIN_COLUMN_WIDTH) {
      break;
    }
    fitted[fitted.indexOf(widest)] = widest - 1;
    total -= 1;
  }
  return fitted;
};

const renderTable = ({
  items,
  columns,
  width,
}: {
  items: readonly unknown[];
  columns: readonly string[] | undefined;
  width: number | undefined;
}): string => {
  if (items.length === 0) {
    return "(no results)";
  }
  const first = items.at(0);
  const allCols = columns ?? (isRecord(first) ? Object.keys(first) : ["value"]);
  const allRows = items.map((item) =>
    allCols.map((col) =>
      isRecord(item) ? formatCell(item[col]) : formatCell(item),
    ),
  );
  // An inferred column that is empty on every row carries nothing; a caller's
  // explicit column list is kept as given.
  const keep = allCols.map(
    (_col, index) =>
      columns !== undefined || allRows.some((row) => row[index] !== ""),
  );
  const cols = keep.some(Boolean)
    ? allCols.filter((_col, index) => keep[index])
    : allCols;
  const rows = allRows.map((row) =>
    keep.some(Boolean) ? row.filter((_cell, index) => keep[index]) : row,
  );
  const widths = fitWidths(
    cols.map((col, index) =>
      Math.max(
        displayWidth(col),
        ...rows.map((row) => displayWidth(row[index] ?? "")),
      ),
    ),
    width,
  );
  const pad = (cells: readonly string[]): string =>
    cells
      .map((cell, index) => {
        const columnWidth = widths[index] ?? displayWidth(cell);
        return padToWidth(truncate(cell, columnWidth), columnWidth);
      })
      .join(" ".repeat(COLUMN_GUTTER))
      .trimEnd();
  const header = pad(cols);
  const separator = widths
    .map((columnWidth) => "-".repeat(columnWidth))
    .join(" ".repeat(COLUMN_GUTTER));
  return [header, separator, ...rows.map(pad)].join("\n");
};

/**
 * One level of nesting is flattened to dotted keys (`matter.name`), so a
 * response that groups its fields reads as a list instead of JSON blobs.
 */
const flattenRecord = (
  payload: Record<string, unknown>,
): readonly (readonly [string, unknown])[] => {
  const entries: (readonly [string, unknown])[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (isRecord(value) && Object.keys(value).length > 0) {
      for (const [subKey, subValue] of Object.entries(value)) {
        entries.push([`${key}.${subKey}`, subValue]);
      }
      continue;
    }
    entries.push([key, value]);
  }
  return entries;
};

const renderKeyValue = (
  payload: unknown,
  width: number | undefined,
): string => {
  if (!isRecord(payload)) {
    return formatCell(payload);
  }
  const entries = flattenRecord(payload);
  if (entries.length === 0) {
    return "(empty)";
  }
  const keyWidth = Math.max(...entries.map(([key]) => displayWidth(key)));
  const valueWidth =
    width === undefined
      ? undefined
      : Math.max(width - keyWidth - COLUMN_GUTTER, MIN_COLUMN_WIDTH);
  return entries
    .map(([key, value]) => {
      const cell = formatCell(value);
      // A value with no whitespace is an identifier, token, or URL: cut short
      // it cannot be copied into the next command, so it may wrap instead.
      const shown =
        valueWidth === undefined || !/\s/u.test(cell)
          ? cell
          : truncate(cell, valueWidth);
      return `${padToWidth(key, keyWidth)}${" ".repeat(COLUMN_GUTTER)}${shown}`.trimEnd();
    })
    .join("\n");
};

/**
 * Summary lines, then one titled table per section. A section with no rows
 * says so, so an empty table is never mistaken for a missing one.
 */
const renderComposite = (
  payload: unknown,
  view: CompositeView,
  width: number | undefined,
): string => {
  const summary: Record<string, unknown> = {};
  for (const path of view.summary) {
    const value = valueAtPath(payload, path);
    if (value !== undefined && value !== null) {
      summary[path] = value;
    }
  }
  const blocks = [renderKeyValue(summary, width)];
  for (const section of view.sections) {
    const headers = section.columns.map((column) => columnHeader(column));
    const rows = gatherRows(payload, section.rows).map((gathered) =>
      Object.fromEntries(
        section.columns.map((column) => [
          columnHeader(column),
          columnValue(gathered, column),
        ]),
      ),
    );
    blocks.push(
      rows.length === 0
        ? `${section.title}: none`
        : `${section.title}\n${renderTable({ items: rows, columns: headers, width })}`,
    );
  }
  return blocks.join("\n\n");
};

export type Writers = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

/**
 * Render a plan to stdout, emitting a `--cursor` resume hint on stderr.
 * `width` is the terminal's column count; a table is fitted to it (columns
 * shrink, cells truncate with an ellipsis) so a row never wraps. JSON output
 * ignores it.
 */
export const renderResult = ({
  plan,
  format,
  writers,
  allActive,
  width,
}: {
  plan: RenderPlan;
  format: OutputFormat;
  writers: Writers;
  allActive: boolean;
  width?: number | undefined;
}): void => {
  if (plan.kind === "raw-text") {
    writers.stdout(plan.text.endsWith("\n") ? plan.text : `${plan.text}\n`);
    return;
  }

  if (plan.kind === "windowed-text") {
    const textResult = {
      text: plan.text,
      ...(plan.url === undefined ? {} : { url: plan.url }),
      ...(plan.source_url === undefined ? {} : { source_url: plan.source_url }),
    };
    if (format === "json") {
      writers.stdout(`${JSON.stringify(textResult, null, 2)}\n`);
    } else if (format === "jsonl") {
      writers.stdout(jsonlLine(textResult));
    } else {
      writers.stdout(plan.text.endsWith("\n") ? plan.text : `${plan.text}\n`);
    }
    if (!allActive && plan.nextCursor !== null) {
      writers.stderr(`more: --cursor ${plan.nextCursor}\n`);
    }
    return;
  }

  if (plan.kind === "text-unavailable") {
    if (format === "json") {
      writers.stdout(
        `${JSON.stringify(textUnavailableEnvelope(plan), null, 2)}\n`,
      );
    } else if (format === "jsonl") {
      writers.stdout(jsonlLine(textUnavailableEnvelope(plan)));
    } else {
      writers.stdout(`${renderKeyValue(plan.payload, width)}\n`);
    }
    writers.stderr(`${textUnavailableMessage(plan.reason, plan.textPath)}\n`);
    return;
  }

  if (plan.kind === "composite") {
    if (format === "json") {
      writers.stdout(`${JSON.stringify(plan.payload, null, 2)}\n`);
    } else if (format === "jsonl") {
      writers.stdout(jsonlLine(plan.payload));
    } else {
      writers.stdout(`${renderComposite(plan.payload, plan.view, width)}\n`);
    }
    return;
  }

  if (plan.kind === "single") {
    if (format === "json") {
      writers.stdout(`${JSON.stringify(plan.payload, null, 2)}\n`);
    } else if (format === "jsonl") {
      writers.stdout(jsonlLine(plan.payload));
    } else {
      writers.stdout(`${renderKeyValue(plan.payload, width)}\n`);
    }
    return;
  }

  // page envelope
  if (format === "json") {
    writers.stdout(`${JSON.stringify(plan.payload, null, 2)}\n`);
  } else if (format === "jsonl") {
    // One item per line, so a page streams the same shape --all does (spec §3).
    for (const item of plan.items) {
      writers.stdout(jsonlLine(item));
    }
  } else {
    writers.stdout(
      `${renderTable({ items: plan.items, columns: plan.columns, width })}\n`,
    );
  }
  if (!allActive && plan.nextCursor !== null) {
    writers.stderr(`more: --cursor ${plan.nextCursor}\n`);
  }
};

/** The terminal's column count when stdout is a TTY, else undefined (no fitting). */
export const terminalWidth = (context: {
  process: {
    stdout: { isTTY?: boolean | undefined; columns?: number | undefined };
  };
}): number | undefined =>
  context.process.stdout.isTTY === true
    ? context.process.stdout.columns
    : undefined;
