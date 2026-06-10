/**
 * Template Fill Preview — flow-block substitution stage.
 *
 * Rewrites the FlowBlock stream the layout engine consumes so each matched
 * `{{marker}}` range lays out as if its text were the typed preview value:
 * line wrap, pagination, and following text reflow naturally instead of the
 * marker's original width persisting as dead space (the previous overlay
 * approach painted covers over the marker rects, which could not reflow).
 *
 * The substitution is strictly view-side: the ProseMirror document is never
 * touched, so the save path (which converts from the PM doc) is unaffected.
 * The value run keeps the marker's PM range ([from, to)) while carrying the
 * value text, so click-to-position and selection mapping still resolve into
 * the marker range; the host run's formatting is carried onto the value so
 * it renders like the surrounding text. `templatePreview` on the run tells
 * the painter to add the preview classes (`highlighted` paints the accent
 * chip as a layout-aware inline highlight).
 *
 * Untouched blocks/runs are returned by reference so the painter's
 * fingerprinting and the incremental measure path see them unchanged.
 */

import type {
  FlowBlock,
  ParagraphBlock,
  Run,
  TableBlock,
  TableCell,
  TableRow,
  TextBoxBlock,
  TextRun,
} from "../layout-engine/types";

/** One marker→value substitution, in PM doc positions. */
export type TemplatePreviewFlowEntry = {
  /** Inclusive PM doc position of the marker start. */
  from: number;
  /** Exclusive PM doc position of the marker end. */
  to: number;
  /** The typed value displayed in place of the marker. */
  value: string;
};

export type TemplatePreviewFlowOptions = {
  entries: readonly TemplatePreviewFlowEntry[];
  /** `highlighted` marks substituted runs for the accent-chip CSS. */
  mode: "highlighted" | "plain";
};

/**
 * Replace each entry's marker range with its preview value across the given
 * flow blocks (recursing into table cells and text boxes). Returns the input
 * array unchanged when there is nothing to substitute.
 */
export function applyTemplatePreviewToBlocks(
  blocks: FlowBlock[],
  { entries, mode }: TemplatePreviewFlowOptions,
): FlowBlock[] {
  if (entries.length === 0) {
    return blocks;
  }
  const sorted = [...entries].sort((a, b) => a.from - b.from);
  let changed = false;
  const next: FlowBlock[] = [];
  for (const block of blocks) {
    const transformed = transformBlock(block, sorted, mode);
    changed ||= transformed !== block;
    next.push(transformed);
  }
  return changed ? next : blocks;
}

function transformBlock(
  block: FlowBlock,
  entries: TemplatePreviewFlowEntry[],
  mode: TemplatePreviewFlowOptions["mode"],
): FlowBlock {
  if (block.kind === "paragraph") {
    return transformParagraph(block, entries, mode);
  }
  if (block.kind === "table") {
    return transformTable(block, entries, mode);
  }
  if (block.kind === "textBox") {
    return transformTextBox(block, entries, mode);
  }
  return block;
}

function transformTable(
  block: TableBlock,
  entries: TemplatePreviewFlowEntry[],
  mode: TemplatePreviewFlowOptions["mode"],
): TableBlock {
  let changed = false;
  const rows: TableRow[] = [];
  for (const row of block.rows) {
    let rowChanged = false;
    const cells: TableCell[] = [];
    for (const cell of row.cells) {
      let cellChanged = false;
      const cellBlocks: FlowBlock[] = [];
      for (const cellBlock of cell.blocks) {
        const transformed = transformBlock(cellBlock, entries, mode);
        cellChanged ||= transformed !== cellBlock;
        cellBlocks.push(transformed);
      }
      cells.push(cellChanged ? { ...cell, blocks: cellBlocks } : cell);
      rowChanged ||= cellChanged;
    }
    rows.push(rowChanged ? { ...row, cells } : row);
    changed ||= rowChanged;
  }
  return changed ? { ...block, rows } : block;
}

function transformTextBox(
  block: TextBoxBlock,
  entries: TemplatePreviewFlowEntry[],
  mode: TemplatePreviewFlowOptions["mode"],
): TextBoxBlock {
  let changed = false;
  const content: ParagraphBlock[] = [];
  for (const paragraph of block.content) {
    const transformed = transformParagraph(paragraph, entries, mode);
    changed ||= transformed !== paragraph;
    content.push(transformed);
  }
  return changed ? { ...block, content } : block;
}

function transformParagraph(
  block: ParagraphBlock,
  entries: TemplatePreviewFlowEntry[],
  mode: TemplatePreviewFlowOptions["mode"],
): ParagraphBlock {
  // Cheap reject: markers never cross block boundaries, so a paragraph whose
  // PM span misses every entry passes through by reference.
  const blockFrom = block.pmStart;
  const blockTo = block.pmEnd;
  if (blockFrom !== undefined && blockTo !== undefined) {
    const touches = entries.some(
      (entry) => entry.from < blockTo && entry.to > blockFrom,
    );
    if (!touches) {
      return block;
    }
  }

  const runs: Run[] = [];
  let changed = false;
  for (const run of block.runs) {
    if (transformRun(run, entries, mode, runs)) {
      changed = true;
    }
  }
  return changed ? { ...block, runs } : block;
}

/**
 * Push the transformed projection of `run` onto `out`. Returns true when the
 * run was changed (sliced, replaced, or dropped); unchanged runs are pushed
 * by reference.
 */
function transformRun(
  run: Run,
  entries: TemplatePreviewFlowEntry[],
  mode: TemplatePreviewFlowOptions["mode"],
  out: Run[],
): boolean {
  const pmStart = run.pmStart;
  const pmEnd = run.pmEnd;
  if (pmStart === undefined || pmEnd === undefined) {
    out.push(run);
    return false;
  }

  const overlapping = entries.filter(
    (entry) => entry.from < pmEnd && entry.to > pmStart,
  );
  if (overlapping.length === 0) {
    out.push(run);
    return false;
  }

  if (run.kind !== "text") {
    // Non-text inline nodes (tab, hard break, …) occupy one PM position, so
    // an overlap means the marker swallowed them whole — drop with the rest
    // of the marker text.
    return true;
  }

  let cursor = pmStart;
  for (const entry of overlapping) {
    if (entry.from > cursor) {
      out.push(sliceTextRun(run, pmStart, cursor, entry.from));
    }
    // The run hosting the marker start contributes its formatting to the
    // value run; runs the marker merely continues through are dropped (the
    // value was already emitted at the marker start).
    if (entry.from >= pmStart) {
      out.push(buildValueRun(run, entry, mode));
    }
    cursor = Math.min(entry.to, pmEnd);
  }
  if (cursor < pmEnd) {
    out.push(sliceTextRun(run, pmStart, cursor, pmEnd));
  }
  return true;
}

/** Slice `run` to the PM range [from, to); positions map 1:1 onto chars. */
function sliceTextRun(
  run: TextRun,
  base: number,
  from: number,
  to: number,
): TextRun {
  return {
    ...run,
    text: run.text.slice(from - base, to - base),
    pmStart: from,
    pmEnd: to,
  };
}

function buildValueRun(
  host: TextRun,
  entry: TemplatePreviewFlowEntry,
  mode: TemplatePreviewFlowOptions["mode"],
): TextRun {
  return {
    ...host,
    text: entry.value,
    pmStart: entry.from,
    pmEnd: entry.to,
    templatePreview: mode,
  };
}

const entryKey = (entry: TemplatePreviewFlowEntry): string =>
  `${entry.from}:${entry.to}:${entry.value}`;

/**
 * PM range covering every substitution that differs between two preview
 * states (changed, added, or removed entries), or `null` when the
 * substituted flow content is identical. Feeds the layout pipeline's
 * dirty-range invalidation so typing a value re-measures only the blocks
 * hosting the affected markers.
 */
export function templatePreviewDirtyRange(
  previous: readonly TemplatePreviewFlowEntry[],
  next: readonly TemplatePreviewFlowEntry[],
): { from: number; to: number } | null {
  const previousKeys = new Set(previous.map(entryKey));
  const nextKeys = new Set(next.map(entryKey));
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  for (const entry of previous) {
    if (!nextKeys.has(entryKey(entry))) {
      from = Math.min(from, entry.from);
      to = Math.max(to, entry.to);
    }
  }
  for (const entry of next) {
    if (!previousKeys.has(entryKey(entry))) {
      from = Math.min(from, entry.from);
      to = Math.max(to, entry.to);
    }
  }
  if (from === Number.POSITIVE_INFINITY) {
    return null;
  }
  return { from, to };
}
