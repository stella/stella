/**
 * Structural projection of a folio-parsed Document into a normalised JSON
 * shape that can be compared against the equivalent projection produced
 * by an external OOXML parser (currently python-docx). The two
 * projections are intentionally narrow: they only cover fields that both
 * sides expose and that map cleanly across parser ASTs.
 *
 * Adding a field here means: extend the python projector in the same
 * directory in lockstep, and update README.md.
 */

import type {
  BlockContent,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  ParagraphContent,
  BlockSdt,
  InlineSdt,
  SdtProperties,
  SdtType,
} from "../../src/core/types/content";
import type { Document } from "../../src/core/types/document";

/**
 * Normalised SDT projection. Keys are deliberately ordered and only
 * include fields python-docx can recover from the wire format.
 *
 * Optional fields use `string | undefined` (not bare `string?`) so that
 * with `exactOptionalPropertyTypes: true` callers can assign the source
 * value directly without first narrowing away `undefined`. The python
 * projector omits the key when the wire format has no value, so the
 * structural diff already treats `missing` and `undefined` identically.
 */
export type SdtProjection = {
  scope: "block" | "inline";
  sdtType: SdtType;
  alias: string | undefined;
  tag: string | undefined;
  lock: NonNullable<SdtProperties["lock"]> | undefined;
  /** Number of direct child elements inside the SDT (paragraphs/tables for
   *  block scope, runs/fields/etc. for inline scope). */
  childCount: number;
};

export type StructuralProjection = {
  /** Schema version so a future python projector and this projector can
   *  detect drift loudly instead of silently diffing different shapes. */
  schemaVersion: 1;
  /** All paragraphs reachable from the body subtree (top level + nested
   *  in tables and block SDTs). Mirrors python-docx counting against the
   *  `w:p` element set. */
  totalParagraphs: number;
  /** All tables reachable from the body subtree (`w:tbl`). */
  totalTables: number;
  /** Top-level block content count (paragraph | table | blockSdt). */
  topLevelBlocks: number;
  /** SDT inventory in document order. */
  sdts: SdtProjection[];
  /** SDT count by type. Useful for a quick eyeball diff. */
  sdtCountsByType: Partial<Record<SdtType | "block" | "inline", number>>;
};

/**
 * Run counts intentionally omitted from the projection: folio applies a
 * run consolidator (adjacent identically-formatted `w:r` elements collapse
 * into one), so wire-format run counts will always diverge from
 * python-docx's `w:r` count on real documents. Adding it back would make
 * every interesting fixture diverge for an uninteresting reason. If
 * future work needs run-level parity, compare *consolidated* runs on both
 * sides (e.g., post-process python-docx output through the same merge
 * rules) rather than raw `w:r` count.
 */

/**
 * Project a folio Document into the normalised structural shape.
 */
export function projectFolioDocument(doc: Document): StructuralProjection {
  const body = doc.package.document;
  const sdts: SdtProjection[] = [];
  let totalParagraphs = 0;
  let totalTables = 0;

  const visitBlock = (block: BlockContent): void => {
    if (block.type === "paragraph") {
      visitParagraph(block);
      return;
    }
    if (block.type === "table") {
      visitTable(block);
      return;
    }
    // BlockContent = Paragraph | Table | BlockSdt — the remaining branch
    // is structurally guaranteed to be a BlockSdt. An explicit
    // `block.type === "blockSdt"` check trips no-unnecessary-condition
    // because the comparison is between two literal types.
    visitBlockSdt(block);
  };

  const visitParagraph = (p: Paragraph): void => {
    totalParagraphs += 1;
    visitInlineSequence(p.content);
  };

  /**
   * Walk a sequence of inline content (paragraph body or another inline
   * SDT's children), emitting one SDT projection per *wire* `w:sdt`.
   *
   * Folio's `pushInlineSdtSegments` deliberately splits a single wire
   * `w:sdt` whose content straddles a lifted marker (bookmark / comment
   * range / tracked-change boundary) into multiple `InlineSdt` records
   * that all share the same `SdtProperties` object reference. The python
   * projector walks the XML and emits one entry per wire `w:sdt`, so to
   * keep the differential signal honest we coalesce those split segments
   * back into a single projection here (summing their `childCount`).
   *
   * Reference identity is sufficient: `parseSdtProperties` is called
   * exactly once per wire `w:sdt`, and the resulting object is passed
   * unchanged to every segment. Two distinct `w:sdt`s — even with
   * identical alias/tag/lock — produce two distinct property objects.
   *
   * Runs, fields, comment markers, tracked-change markers, math: we walk
   * into inline SDTs (they carry alias/tag/lock we want to compare),
   * but otherwise the projection does not count paragraph-content
   * items — see the run-count comment near `StructuralProjection`.
   */
  const visitInlineSequence = (items: readonly ParagraphContent[]): void => {
    let pendingProps: SdtProperties | null = null;
    let pendingChildCount = 0;
    let pendingNested: InlineSdt[] = [];

    const flush = (): void => {
      if (pendingProps === null) {
        return;
      }
      sdts.push({
        scope: "inline",
        sdtType: pendingProps.sdtType,
        alias: pendingProps.alias,
        tag: pendingProps.tag,
        lock: pendingProps.lock,
        childCount: pendingChildCount,
      });
      const nested = pendingNested;
      pendingProps = null;
      pendingChildCount = 0;
      pendingNested = [];
      for (const child of nested) {
        visitInlineSequence(child.content);
      }
    };

    for (const item of items) {
      if (item.type !== "inlineSdt") {
        // Lifted markers (bookmarks, comment ranges, tracked-change
        // boundaries) appear as non-inlineSdt siblings between segments
        // of the same wire `w:sdt`. Don't flush on them: keep the
        // pending SDT alive so a later same-reference segment coalesces
        // into one projection, matching python-docx's one entry per
        // `w:sdt`.
        continue;
      }
      if (pendingProps !== null && pendingProps !== item.properties) {
        flush();
      }
      pendingProps = item.properties;
      pendingChildCount += item.content.length;
      pendingNested.push(item);
    }
    flush();
  };

  const visitTable = (t: Table): void => {
    totalTables += 1;
    for (const row of t.rows) {
      visitRow(row);
    }
  };

  const visitRow = (row: TableRow): void => {
    for (const cell of row.cells) {
      visitCell(cell);
    }
  };

  const visitCell = (cell: TableCell): void => {
    for (const child of cell.content) {
      if (child.type === "paragraph") {
        visitParagraph(child);
      } else {
        visitTable(child);
      }
    }
  };

  const visitBlockSdt = (sdt: BlockSdt): void => {
    sdts.push({
      scope: "block",
      sdtType: sdt.properties.sdtType,
      alias: sdt.properties.alias,
      tag: sdt.properties.tag,
      lock: sdt.properties.lock,
      childCount: sdt.content.length,
    });
    for (const child of sdt.content) {
      if (child.type === "paragraph") {
        visitParagraph(child);
      } else {
        visitTable(child);
      }
    }
  };

  for (const block of body.content) {
    visitBlock(block);
  }

  return {
    schemaVersion: 1,
    totalParagraphs,
    totalTables,
    topLevelBlocks: body.content.length,
    sdts,
    sdtCountsByType: summariseSdts(sdts),
  };
}

const summariseSdts = (
  sdts: readonly SdtProjection[],
): StructuralProjection["sdtCountsByType"] => {
  const out: StructuralProjection["sdtCountsByType"] = {};
  for (const s of sdts) {
    out[s.sdtType] = (out[s.sdtType] ?? 0) + 1;
    out[s.scope] = (out[s.scope] ?? 0) + 1;
  }
  return out;
};

/**
 * Diff two structural projections. Returns the empty array on equivalence.
 *
 * The differential test ignores absolute values and only reports field-by-
 * field divergences. python-docx returns a vanilla shape so unknown keys
 * are not expected; if a future python projector emits unknown fields they
 * will show up as `extraField`/`missingField` diffs and surface the drift.
 */
export type Divergence = {
  path: string;
  folio: unknown;
  reference: unknown;
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function diffProjections(
  folio: StructuralProjection,
  reference: unknown,
): Divergence[] {
  const out: Divergence[] = [];
  walk("", folio, reference, out);
  return out;
}

const walk = (
  path: string,
  folio: unknown,
  reference: unknown,
  out: Divergence[],
): void => {
  if (Array.isArray(folio)) {
    if (!Array.isArray(reference) || folio.length !== reference.length) {
      out.push({ path: path || "$", folio, reference });
      return;
    }
    for (const [i, item] of folio.entries()) {
      walk(`${path}[${i}]`, item, reference[i], out);
    }
    return;
  }
  if (isPlainObject(folio)) {
    if (!isPlainObject(reference)) {
      out.push({ path: path || "$", folio, reference });
      return;
    }
    const keys = new Set([...Object.keys(folio), ...Object.keys(reference)]);
    for (const k of keys) {
      walk(path ? `${path}.${k}` : k, folio[k], reference[k], out);
    }
    return;
  }
  if (folio !== reference) {
    out.push({ path: path || "$", folio, reference });
  }
};
