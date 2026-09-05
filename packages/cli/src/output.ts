// Output layer (spec 051 S4). Every response is parsed as
// `JSON.parse(content[0].text)` upstream; here we pick the render shape as a
// discriminated union (page envelope / single object / windowed text / raw
// text) and render it as a table (default on a TTY) or pretty JSON (default off
// a TTY), honoring `--output`/`--json`/`--table`. `nextCursor` hints and `--all`
// truncation notices go to stderr so a piped JSON stdout stays clean.

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

/** The four mutually exclusive render shapes (spec S4). */
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
  | { kind: "windowed-text"; text: string; nextCursor: string | null }
  | { kind: "raw-text"; text: string };

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
 * Choose the render shape for a parsed payload given the leaf's annotations and
 * whether a single-read flip is active for this invocation (spec S4).
 */
export const buildRenderPlan = ({
  payload,
  itemsKey,
  windowedText,
  singleReadActive,
  columns,
}: {
  payload: unknown;
  itemsKey: string | undefined;
  windowedText: boolean;
  singleReadActive: boolean;
  columns: readonly string[] | undefined;
}): RenderPlan => {
  if (windowedText) {
    return {
      kind: "windowed-text",
      text: asString(fieldOf(payload, "text")) ?? "",
      nextCursor: asString(fieldOf(payload, "nextCursor")),
    };
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
      const shown =
        valueWidth === undefined ? cell : truncate(cell, valueWidth);
      return `${padToWidth(key, keyWidth)}${" ".repeat(COLUMN_GUTTER)}${shown}`.trimEnd();
    })
    .join("\n");
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
    if (format === "json") {
      writers.stdout(`${JSON.stringify({ text: plan.text }, null, 2)}\n`);
    } else if (format === "jsonl") {
      writers.stdout(jsonlLine({ text: plan.text }));
    } else {
      writers.stdout(plan.text.endsWith("\n") ? plan.text : `${plan.text}\n`);
    }
    if (!allActive && plan.nextCursor !== null) {
      writers.stderr(`more: --cursor ${plan.nextCursor}\n`);
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
