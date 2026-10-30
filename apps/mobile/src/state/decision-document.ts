import * as v from "valibot";

/**
 * A decision's text as the reader draws it: the web reader's document
 * (`@stll/legal-ast` blocks of inlines) reduced to what a phone sets in
 * type. Inline marks become runs that carry their emphasis; citations and
 * links read as their printed words; a table reads row by row.
 */

/** A stretch of text in one emphasis. */
export type ReaderRun = {
  /** Its place among its block's runs, which a list keys it by. */
  readonly id: string;
  readonly text: string;
  readonly strong: boolean;
  readonly emphasis: boolean;
};

export type ReaderBlock =
  | {
      readonly kind: "heading";
      readonly id: string;
      readonly level: number;
      readonly runs: readonly ReaderRun[];
    }
  | {
      readonly kind: "paragraph";
      readonly id: string;
      /** The court's own paragraph number, where it numbers them. */
      readonly number: number | null;
      /** Nesting of a list item, zero outside a list. */
      readonly depth: number;
      /** Quoted matter, set in from the margin as the web reader sets it. */
      readonly quote: boolean;
      readonly runs: readonly ReaderRun[];
    }
  | {
      readonly kind: "table";
      readonly id: string;
      readonly rows: readonly ReaderTableRow[];
    };

type ReaderTableRow = {
  readonly id: string;
  readonly cells: readonly { readonly id: string; readonly text: string }[];
};

type Marks = { readonly strong: boolean; readonly emphasis: boolean };

/** Text in its emphasis, before neighbours are joined into runs. */
type MarkedText = Omit<ReaderRun, "id">;

const PLAIN: Marks = { strong: false, emphasis: false };

const inlineSchema = v.looseObject({
  type: v.string(),
  text: v.optional(v.string()),
  label: v.optional(v.string()),
  children: v.optional(v.array(v.unknown())),
});

const blockSchema = v.looseObject({
  id: v.optional(v.string()),
  type: v.string(),
  level: v.optional(v.number()),
  role: v.optional(v.string()),
  listDepth: v.optional(v.number()),
  number: v.optional(v.number()),
  inlines: v.optional(v.array(v.unknown())),
  rows: v.optional(
    v.array(
      v.array(v.looseObject({ inlines: v.optional(v.array(v.unknown())) })),
    ),
  ),
});

/** The blocks this build can draw, in order; anything else is left out. */
export const readerBlocks = (blocks: readonly unknown[]): ReaderBlock[] =>
  blocks.flatMap((raw, index): ReaderBlock[] => {
    const parsed = v.safeParse(blockSchema, raw);
    if (!parsed.success) {
      return [];
    }
    const block = parsed.output;
    const id = block.id ?? String(index);
    if (block.type === "heading") {
      const runs = readerRuns(block.inlines ?? []);
      return runs.length === 0
        ? []
        : [{ kind: "heading", id, level: block.level ?? 2, runs }];
    }
    if (block.type === "paragraph") {
      const runs = readerRuns(block.inlines ?? []);
      return runs.length === 0
        ? []
        : [
            {
              kind: "paragraph",
              id,
              number: block.number ?? null,
              depth: block.listDepth ?? 0,
              quote: block.role === "quote",
              runs,
            },
          ];
    }
    if (block.type === "table") {
      const rows = (block.rows ?? [])
        .map((row, rowIndex) => ({
          id: `${id}.${rowIndex}`,
          cells: row.map((cell, cellIndex) => ({
            id: `${id}.${rowIndex}.${cellIndex}`,
            text: readerRuns(cell.inlines ?? [])
              .map((run) => run.text)
              .join("")
              .trim(),
          })),
        }))
        .filter((row) => row.cells.some((cell) => cell.text !== ""));
      return rows.length === 0 ? [] : [{ kind: "table", id, rows }];
    }
    return [];
  });

/** Inlines as runs of text, neighbours in the same emphasis joined. */
export const readerRuns = (inlines: readonly unknown[]): ReaderRun[] => {
  const runs: MarkedText[] = [];
  for (const run of inlineRuns(inlines, PLAIN)) {
    const last = runs.at(-1);
    if (
      last !== undefined &&
      last.strong === run.strong &&
      last.emphasis === run.emphasis
    ) {
      runs[runs.length - 1] = { ...last, text: last.text + run.text };
    } else {
      runs.push(run);
    }
  }
  return runs.every((run) => run.text.trim() === "")
    ? []
    : runs.map((run, index) => ({ id: String(index), ...run }));
};

/**
 * Paragraphs of a decision that has only plain text: blank lines part them,
 * as the publisher's text does.
 */
export const plainTextBlocks = (fulltext: string): ReaderBlock[] =>
  fulltext
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "")
    .map((paragraph, index) => ({
      kind: "paragraph",
      id: String(index),
      number: null,
      depth: 0,
      quote: false,
      runs: [{ id: "0", text: paragraph, ...PLAIN }],
    }));

function inlineRuns(inlines: readonly unknown[], marks: Marks): MarkedText[] {
  return inlines.flatMap((raw): MarkedText[] => {
    const parsed = v.safeParse(inlineSchema, raw);
    if (!parsed.success) {
      return [];
    }
    const inline = parsed.output;
    switch (inline.type) {
      case "text":
        return inline.text === undefined
          ? []
          : [{ text: inline.text, ...marks }];
      case "line-break":
        return [{ text: "\n", ...marks }];
      // A printed page number is the scan's furniture, not the text.
      case "page-anchor":
        return [];
      case "bold":
        return inlineRuns(inline.children ?? [], { ...marks, strong: true });
      case "italic":
        return inlineRuns(inline.children ?? [], { ...marks, emphasis: true });
      default:
        // Underline, scripts, links and citations read as their words.
        return inlineRuns(inline.children ?? [], marks);
    }
  });
}
