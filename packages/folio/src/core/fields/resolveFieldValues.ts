import { parseFieldInstruction } from "../docx/fieldParser";
import type {
  BlockId,
  FieldRun,
  FlowBlock,
  Page,
} from "../layout-engine/types";
import { evaluateField } from "./evaluateField";
import type { FieldContext } from "./fieldContext";

/** Layout-derived inputs shared by every field, regardless of its position. */
export type SharedFieldInputs = {
  totalPages: number;
  bookmarkPages: ReadonlyMap<string, number>;
  bookmarkText: ReadonlyMap<string, string>;
  seqValues: ReadonlyMap<number, number>;
  /** Section index -> page count, for SECTIONPAGES. */
  sectionPageCounts: ReadonlyMap<number, number>;
  now: Date;
};

type BlockLocation = { page: number; sectionIndex: number };

export type ResolvedFieldValues = {
  /** Field run `pmStart` -> resolved display text. */
  values: Map<number, string>;
  /**
   * True when at least one field resolved to a string that differs from the
   * text it was measured at (`fallback || "1"`), i.e. a re-measure would change
   * line widths. The driver uses this to skip re-layout when nothing moved.
   */
  changed: boolean;
};

/**
 * Resolve every field run to its display value against a finished layout, keyed
 * by the run's `pmStart`. Each field is evaluated for the page its top-level
 * block lands on (fields inside a table/text box take that container's page).
 * Feed `values` back into `measureBlocks({ fieldValues })` so fields measure at
 * their painted width.
 */
export function resolveFieldValues(
  blocks: readonly FlowBlock[],
  pages: readonly Page[],
  shared: SharedFieldInputs,
): ResolvedFieldValues {
  const blockPage = buildBlockPageMap(pages);
  const values = new Map<number, string>();
  let changed = false;

  for (const block of blocks) {
    const location = blockPage.get(block.id);
    const fields: FieldRun[] = [];
    collectFieldRuns(block, fields);

    for (const run of fields) {
      if (run.pmStart === undefined) {
        continue;
      }
      const sectionPages = location
        ? shared.sectionPageCounts.get(location.sectionIndex)
        : undefined;
      const context: FieldContext = {
        pageNumber: location?.page ?? 1,
        totalPages: shared.totalPages,
        bookmarkPages: shared.bookmarkPages,
        bookmarkText: shared.bookmarkText,
        seqValues: shared.seqValues,
        now: shared.now,
        ...(sectionPages === undefined ? {} : { sectionPages }),
      };
      const value = evaluateField(
        parseFieldInstruction(run.instruction || run.fieldType),
        context,
        { fallback: run.fallback ?? "", instanceId: run.pmStart },
      );
      values.set(run.pmStart, value);
      if (value !== (run.fallback || "1")) {
        changed = true;
      }
    }
  }

  return { values, changed };
}

const EMPTY_STRING_NUMBER: ReadonlyMap<string, number> = new Map();
const EMPTY_STRING_STRING: ReadonlyMap<string, string> = new Map();
const EMPTY_NUMBER_NUMBER: ReadonlyMap<number, number> = new Map();

/**
 * Field values for measuring header/footer blocks, which are laid out once but
 * painted on every page with a different page number. Page-number fields
 * (PAGE/NUMPAGES/SECTIONPAGES) are reserved at the width of the largest page
 * (`pageCount`) so a multi-digit number on a later page can't wrap differently
 * than the single layout; other fields keep their fallback (resolved per-page at
 * paint). `pageCount` is the document's page count — a prior render's count is a
 * fine estimate, since headers are measured before the body is re-laid-out.
 */
export function buildHeaderFooterFieldValues(
  blocks: readonly FlowBlock[],
  pageCount: number,
  now: Date,
): Map<number, string> {
  const values = new Map<number, string>();
  const fields: FieldRun[] = [];
  for (const block of blocks) {
    collectFieldRuns(block, fields);
  }
  if (fields.length === 0) {
    return values;
  }

  const context: FieldContext = {
    pageNumber: pageCount,
    totalPages: pageCount,
    sectionPages: pageCount,
    bookmarkPages: EMPTY_STRING_NUMBER,
    bookmarkText: EMPTY_STRING_STRING,
    seqValues: EMPTY_NUMBER_NUMBER,
    now,
  };
  for (const run of fields) {
    if (run.pmStart === undefined) {
      continue;
    }
    const parsed = parseFieldInstruction(run.instruction || run.fieldType);
    if (
      parsed.type === "PAGE" ||
      parsed.type === "NUMPAGES" ||
      parsed.type === "SECTIONPAGES"
    ) {
      values.set(
        run.pmStart,
        evaluateField(parsed, context, {
          fallback: run.fallback ?? "",
          instanceId: run.pmStart,
        }),
      );
    }
  }
  return values;
}

/** Whether two resolved-value maps are identical, for loop convergence. */
export function fieldValuesEqual(
  a: ReadonlyMap<number, string>,
  b: ReadonlyMap<number, string>,
): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const [key, value] of a) {
    if (b.get(key) !== value) {
      return false;
    }
  }
  return true;
}

/** First page (and its section) each top-level block lands on. */
function buildBlockPageMap(
  pages: readonly Page[],
): Map<BlockId, BlockLocation> {
  const map = new Map<BlockId, BlockLocation>();
  for (const page of pages) {
    for (const fragment of page.fragments) {
      if (!map.has(fragment.blockId)) {
        map.set(fragment.blockId, {
          page: page.number,
          sectionIndex: page.sectionIndex ?? 0,
        });
      }
    }
  }
  return map;
}

function collectFieldRuns(block: FlowBlock, out: FieldRun[]): void {
  if (block.kind === "paragraph") {
    for (const run of block.runs) {
      if (run.kind === "field") {
        out.push(run);
      }
    }
  } else if (block.kind === "table") {
    for (const row of block.rows) {
      for (const cell of row.cells) {
        for (const cellBlock of cell.blocks) {
          collectFieldRuns(cellBlock, out);
        }
      }
    }
  } else if (block.kind === "textBox") {
    for (const paragraph of block.content) {
      for (const run of paragraph.runs) {
        if (run.kind === "field") {
          out.push(run);
        }
      }
    }
  }
}
