import { parseFieldInstruction } from "../docx/fieldParser";
import type { FlowBlock, ParagraphBlock } from "../layout-engine/types";
import { evaluateField } from "./evaluateField";
import type { FieldContext } from "./fieldContext";

type BookmarkTextInputs = {
  fieldValues?: ReadonlyMap<number, string>;
  seqValues?: ReadonlyMap<number, number>;
};

const EMPTY_STRING_NUMBER: ReadonlyMap<string, number> = new Map();
const EMPTY_STRING_STRING: ReadonlyMap<string, string> = new Map();
const EMPTY_NUMBER_NUMBER: ReadonlyMap<number, number> = new Map();

/**
 * Map each bookmark name to the text of its anchoring paragraph, for REF
 * cross-references (e.g. "see Section 1.3"). Folio anchors bookmarks at the
 * paragraph level, so a REF resolves to that paragraph's visible text. Document
 * order, independent of layout. First paragraph carrying a name wins.
 */
export function buildBookmarkText(
  blocks: readonly FlowBlock[],
  inputs: BookmarkTextInputs = {},
): Map<string, string> {
  const map = new Map<string, string>();
  walkBlocks(blocks, map, inputs);
  return map;
}

function walkBlocks(
  blocks: readonly FlowBlock[],
  map: Map<string, string>,
  inputs: BookmarkTextInputs,
): void {
  for (const block of blocks) {
    if (block.kind === "paragraph") {
      if (!block.bookmarks || block.bookmarks.length === 0) {
        continue;
      }
      const text = paragraphText(block, inputs);
      for (const name of block.bookmarks) {
        if (!map.has(name)) {
          map.set(name, text);
        }
      }
    } else if (block.kind === "table") {
      for (const row of block.rows) {
        for (const cell of row.cells) {
          walkBlocks(cell.blocks, map, inputs);
        }
      }
    } else if (block.kind === "textBox") {
      walkBlocks(block.content, map, inputs);
    }
  }
}

function paragraphText(
  block: ParagraphBlock,
  inputs: BookmarkTextInputs,
): string {
  let text = "";
  for (const run of block.runs) {
    if (run.kind === "text") {
      text += run.text;
    } else if (run.kind === "field") {
      text += bookmarkFieldText(run, inputs);
    }
  }
  return `${visibleListMarker(block)}${text}`.trim();
}

function bookmarkFieldText(
  run: ParagraphBlock["runs"][number],
  inputs: BookmarkTextInputs,
): string {
  if (run.kind !== "field") {
    return "";
  }
  const resolved =
    run.pmStart === undefined
      ? undefined
      : inputs.fieldValues?.get(run.pmStart);
  if (resolved !== undefined) {
    return resolved;
  }
  if (run.pmStart === undefined || !inputs.seqValues?.has(run.pmStart)) {
    return run.fallback ?? "";
  }
  const parsed = parseFieldInstruction(run.instruction || run.fieldType);
  if (parsed.type !== "SEQ") {
    return run.fallback ?? "";
  }
  const context: FieldContext = {
    pageNumber: 1,
    totalPages: 1,
    sectionPages: 1,
    bookmarkPages: EMPTY_STRING_NUMBER,
    bookmarkText: EMPTY_STRING_STRING,
    seqValues: inputs.seqValues ?? EMPTY_NUMBER_NUMBER,
    now: new Date(0),
  };
  return evaluateField(parsed, context, {
    fallback: run.fallback ?? "",
    instanceId: run.pmStart,
    ...(run.fldLock ? { locked: true } : {}),
  });
}

function visibleListMarker(block: ParagraphBlock): string {
  const marker = block.attrs?.listMarker;
  if (!marker || block.attrs?.listMarkerHidden) {
    return "";
  }
  const normalized = marker.replace(/\t+/gu, " ").trim();
  if (!normalized) {
    return "";
  }
  return block.attrs?.listMarkerSuffix === "nothing"
    ? normalized
    : `${normalized} `;
}
