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

const formatCell = (value: unknown): string => {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
};

const renderTable = ({
  items,
  columns,
}: {
  items: readonly unknown[];
  columns: readonly string[] | undefined;
}): string => {
  if (items.length === 0) {
    return "(no results)";
  }
  const first = items.at(0);
  const cols = columns ?? (isRecord(first) ? Object.keys(first) : ["value"]);
  const rows = items.map((item) =>
    cols.map((col) =>
      isRecord(item) ? formatCell(item[col]) : formatCell(item),
    ),
  );
  const widths = cols.map((col, index) =>
    Math.max(col.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const pad = (cells: readonly string[]): string =>
    cells
      .map((cell, index) => cell.padEnd(widths[index] ?? cell.length))
      .join("  ")
      .trimEnd();
  const header = pad(cols);
  const separator = widths.map((width) => "-".repeat(width)).join("  ");
  return [header, separator, ...rows.map(pad)].join("\n");
};

const renderKeyValue = (payload: unknown): string => {
  if (!isRecord(payload)) {
    return formatCell(payload);
  }
  const keys = Object.keys(payload);
  if (keys.length === 0) {
    return "(empty)";
  }
  const width = Math.max(...keys.map((key) => key.length));
  return keys
    .map((key) => `${key.padEnd(width)}  ${formatCell(payload[key])}`)
    .join("\n");
};

export type Writers = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

/** Render a plan to stdout, emitting a `--cursor` resume hint on stderr. */
export const renderResult = ({
  plan,
  format,
  writers,
  allActive,
}: {
  plan: RenderPlan;
  format: OutputFormat;
  writers: Writers;
  allActive: boolean;
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
      writers.stdout(`${renderKeyValue(plan.payload)}\n`);
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
      `${renderTable({ items: plan.items, columns: plan.columns })}\n`,
    );
  }
  if (!allActive && plan.nextCursor !== null) {
    writers.stderr(`more: --cursor ${plan.nextCursor}\n`);
  }
};
