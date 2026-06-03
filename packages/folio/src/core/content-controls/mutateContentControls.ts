/**
 * Pure (immutable) write helpers for block-level content controls.
 *
 * Each helper returns a brand-new `Document` with the requested mutation
 * applied; the original document is never touched. Locked controls and
 * type-incompatible operations throw a tagged error unless `{ force: true }`
 * is passed. `w15:repeatingSection` controls cannot be unwrapped — doing so
 * would orphan their w15 row items.
 */

import { formatDate } from "../docx/fieldParser";
import type {
  BlockContent,
  BlockSdt,
  Document,
  Paragraph,
  Table,
} from "../types/document";
import {
  ContentControlBoundError,
  ContentControlLockedError,
  ContentControlTypeError,
} from "./errors";
import type { ContentControlFilter } from "./findContentControls";

/**
 * Format an ISO 8601 date string using the SDT's modeled `dateFormat`. The
 * w:dateFormat tokens (yyyy/MM/dd/MMMM/HH/mm/ss/AM/PM, etc.) match what
 * `formatDate` already implements for the fields engine; reusing it keeps
 * both surfaces consistent.
 *
 * Returns the ISO input unchanged if the input does not parse as a date or
 * the format is missing — degrading gracefully is better than corrupting
 * the body.
 */
function formatDateForSdtBody(
  isoDate: string,
  dateFormat: string | undefined,
): string {
  if (!dateFormat) {
    return isoDate;
  }
  const parsed = parseSdtDate(isoDate);
  if (!parsed) {
    return isoDate;
  }
  return formatDate(parsed, dateFormat);
}

/**
 * Parse an OOXML SDT date string. `new Date(iso)` parses the input as UTC
 * (a Pacific user would see the previous calendar day via local
 * accessors), so we instead read the ISO components into a local-midnight
 * Date so `formatDate`'s local-time accessors return the same calendar
 * date / wall-clock time in every timezone.
 *
 * Supports date-only (`YYYY-MM-DD`) and date+time (`YYYY-MM-DDTHH:mm[:ss]`)
 * inputs. The trailing `Z` / offset is intentionally ignored — for a date
 * SDT, what the user picked is the displayed wall time, not a moment in
 * UTC.
 */
// Anchor at end so a malformed input that starts with a valid prefix
// (e.g. `2026-06-02abc`, `2026-06-02T`) does not silently succeed on the
// prefix — that would let `formatDate` render a body that disagrees
// with the bound `dateValueISO`. The optional fractional-seconds group
// is critical: `new Date(iso).toISOString()` always emits `.SSS`, so a
// caller round-tripping through Date would otherwise miss the
// timezone-safe component path and the body would shift a day in
// non-UTC zones. The trailing group accepts `Z` / a numeric TZ offset
// — the actual moment-in-time is ignored downstream, but the input has
// to parse cleanly to be considered a date at all.
const SDT_DATE_RE =
  // oxlint-disable-next-line sonarjs/regex-complexity -- ISO 8601 shape; see comment block above
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(?:[Zz]|[+-]\d{2}:?\d{2})?$/u;

function parseSdtDate(iso: string): Date | null {
  const match = SDT_DATE_RE.exec(iso);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hours = match[4] ? Number(match[4]) : 0;
    const minutes = match[5] ? Number(match[5]) : 0;
    const seconds = match[6] ? Number(match[6]) : 0;
    const candidate = new Date(year, month - 1, day, hours, minutes, seconds);
    // Round-trip the captured components against what `Date` actually
    // stored. JS silently normalizes overflow ("2026-99-99" becomes a
    // distant real date), which would let `formatDate` render a
    // misleading body for malformed inputs. Reject the parse when the
    // normalized Date does not agree with what the caller asked for.
    if (
      candidate.getFullYear() !== year ||
      candidate.getMonth() !== month - 1 ||
      candidate.getDate() !== day ||
      candidate.getHours() !== hours ||
      candidate.getMinutes() !== minutes ||
      candidate.getSeconds() !== seconds
    ) {
      return null;
    }
    return candidate;
  }
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

type ForceOption = { force?: boolean };

export type SetContentControlContentInput = string | BlockContent[];

export type SetContentControlValueInput =
  | { kind: "dropdown"; value: string }
  | { kind: "checkbox"; checked: boolean }
  | { kind: "date"; date: string };

function throwLocked(
  control: BlockSdt,
  lock: NonNullable<typeof control.properties.lock>,
): never {
  throw new ContentControlLockedError({
    message: `Control "${control.properties.tag ?? control.properties.alias ?? "(unnamed)"}" has w:lock=${lock}.`,
    lock,
    ...(control.properties.tag !== undefined
      ? { tag: control.properties.tag }
      : {}),
    ...(control.properties.alias !== undefined
      ? { alias: control.properties.alias }
      : {}),
  });
}

/**
 * Refuse content mutations (setContentControlContent /
 * setContentControlValue) when `w:lock` forbids them.
 *
 * Per OOXML §17.5.2.16:
 * - `contentLocked` blocks content edits but allows the container to be
 *   removed.
 * - `sdtContentLocked` blocks both.
 * - `sdtLocked` blocks only container removal, NOT content edits.
 */
function ensureContentNotLocked(
  control: BlockSdt,
  force: boolean | undefined,
): void {
  if (force) {
    return;
  }
  const lock = control.properties.lock;
  if (lock === "contentLocked" || lock === "sdtContentLocked") {
    throwLocked(control, lock);
  }
}

/**
 * Refuse container removal (removeContentControl) when `w:lock` forbids it.
 *
 * - `sdtLocked` blocks container removal but allows content edits.
 * - `sdtContentLocked` blocks both.
 * - `contentLocked` blocks only content edits, NOT container removal.
 */
function ensureSdtNotLocked(
  control: BlockSdt,
  force: boolean | undefined,
): void {
  if (force) {
    return;
  }
  const lock = control.properties.lock;
  if (lock === "sdtLocked" || lock === "sdtContentLocked") {
    throwLocked(control, lock);
  }
}

function isRepeatingSection(control: BlockSdt): boolean {
  // Not modeled in folio's SdtType enum; detected via the captured raw XML.
  // Match by local name so a DOCX that binds the Word 2012 namespace under
  // an alternate prefix (`<ns0:repeatingSection/>`) is still recognized —
  // otherwise `removeContentControl(..., { keepContent: true })` would
  // happily unwrap it and orphan the row items.
  const raw = control.properties.rawPropertiesXml;
  return raw !== undefined && REPEATING_SECTION_RE.test(raw);
}

const REPEATING_SECTION_RE = /<\w+:repeatingSection\b/u;

const DATA_BINDING_RE = /<\w+:dataBinding\b([^>]*)\/?>/iu;

/**
 * Detect a `<w:dataBinding w:xpath="…"/>` (or alt-prefix variant) inside
 * the captured rawPropertiesXml + extract the xpath / storeItemID for
 * the error payload. Returns null when no binding is present.
 */
function readDataBinding(
  control: BlockSdt,
): { xpath: string; storeItemID?: string } | null {
  const raw = control.properties.rawPropertiesXml;
  if (raw === undefined) {
    return null;
  }
  const match = DATA_BINDING_RE.exec(raw);
  if (!match) {
    return null;
  }
  const attrs = match[1] ?? "";
  const xpathMatch = /\bxpath="([^"]*)"/iu.exec(attrs);
  if (!xpathMatch) {
    return null;
  }
  const xpath = xpathMatch[1] ?? "";
  const storeMatch = /\bstoreItemID="([^"]*)"/iu.exec(attrs);
  if (storeMatch) {
    return { xpath, storeItemID: storeMatch[1] ?? "" };
  }
  return { xpath };
}

/**
 * Refuse content mutations on bound SDTs unless the caller passes
 * `{ force: true }`. When force is set, return the rawPropertiesXml
 * with the `<w:dataBinding>` element stripped so the caller's write
 * actually sticks on next Word open. See `ContentControlBoundError`
 * for the rationale.
 */
function ensureContentNotBound(
  control: BlockSdt,
  force: boolean | undefined,
): { strippedRawPropertiesXml: string | undefined } {
  const binding = readDataBinding(control);
  if (!binding) {
    return { strippedRawPropertiesXml: undefined };
  }
  if (!force) {
    throw new ContentControlBoundError({
      message: `Control "${control.properties.tag ?? control.properties.alias ?? "(unnamed)"}" is bound to ${binding.xpath}. Word regenerates the body from the bound XML on open; pass { force: true } to strip the binding inline, or remove it explicitly before writing.`,
      xpath: binding.xpath,
      ...(binding.storeItemID !== undefined
        ? { storeItemID: binding.storeItemID }
        : {}),
      ...(control.properties.tag !== undefined
        ? { tag: control.properties.tag }
        : {}),
      ...(control.properties.alias !== undefined
        ? { alias: control.properties.alias }
        : {}),
    });
  }
  const raw = control.properties.rawPropertiesXml;
  if (raw === undefined) {
    return { strippedRawPropertiesXml: undefined };
  }
  // Strip every dataBinding occurrence; an SDT theoretically can carry
  // only one, but match all defensively.
  const stripped = raw.replaceAll(
    /<\w+:dataBinding\b[^>]*\/?>(?:[\s\S]*?<\/\w+:dataBinding>)?/giu,
    "",
  );
  return { strippedRawPropertiesXml: stripped };
}

/**
 * The `match` callback's return shape:
 * - `undefined` — the SDT did not match the filter; recurse into its body
 * - `null` — match: drop the SDT (and content) entirely
 * - `BlockContent[]` — match: replace the SDT with these blocks (unwrap)
 * - `BlockContent` — match: replace the SDT with this single block
 */
type SdtMatchResult = BlockContent | BlockContent[] | null | undefined;

function mapBlock(
  block: BlockContent,
  match: (b: BlockSdt) => SdtMatchResult,
): BlockContent | BlockContent[] | null {
  if (block.type === "blockSdt") {
    const replaced = match(block);
    if (replaced !== undefined) {
      return replaced;
    }
    const nextContent = transformBlocks(block.content, match);
    // OOXML accepts an empty <w:sdtContent> and folio's toProseDoc has a
    // safety net that inserts a placeholder before the doc reaches PM, but
    // a consumer reading the headless model directly (AI agents, template
    // scanners) would see an inner-empty BlockSdt that nothing in OOXML
    // requires. Keep the model self-consistent: when removing a nested SDT
    // empties its parent SDT, insert a placeholder paragraph so the
    // wrapper still has at least one child.
    const guarded =
      nextContent.length === 0 && block.content.length > 0
        ? [makeParagraphFromText("")]
        : nextContent;
    return { ...block, content: guarded };
  }
  if (block.type === "table") {
    const rows = block.rows.map((row) => ({
      ...row,
      cells: row.cells.map((cell) => {
        const transformed = transformBlocks(cell.content, match);
        const cellContent: (Paragraph | Table)[] = [];
        for (const child of transformed) {
          if (child.type === "paragraph" || child.type === "table") {
            cellContent.push(child);
          }
          // BlockSdt children inside a table cell are currently not part of
          // the cell content model; if such a child survives the transform
          // (e.g. for nested controls), it is dropped here. See the table
          // parser deferral note for cell-level SDTs.
        }
        return { ...cell, content: cellContent };
      }),
    }));
    return { ...block, rows };
  }
  return block;
}

function transformBlocks(
  blocks: BlockContent[],
  match: (b: BlockSdt) => SdtMatchResult,
): BlockContent[] {
  const out: BlockContent[] = [];
  for (const block of blocks) {
    const mapped = mapBlock(block, match);
    if (mapped === null) {
      continue;
    }
    if (Array.isArray(mapped)) {
      out.push(...mapped);
    } else {
      out.push(mapped);
    }
  }
  return out;
}

function withUpdatedBody(doc: Document, content: BlockContent[]): Document {
  return {
    ...doc,
    package: {
      ...doc.package,
      document: {
        ...doc.package.document,
        content,
      },
    },
  };
}

function controlMatchesFilter(
  control: BlockSdt,
  filter: ContentControlFilter,
): boolean {
  // Headless `BlockSdt` model has no PM positions; refuse a pmPos-only
  // filter so a stray pm-side address never accidentally targets every
  // control (see `matches` in `findContentControls`).
  if (filter.pmPos !== undefined) {
    return false;
  }
  if (filter.tag !== undefined && control.properties.tag !== filter.tag) {
    return false;
  }
  if (filter.alias !== undefined && control.properties.alias !== filter.alias) {
    return false;
  }
  if (filter.id !== undefined && control.properties.id !== filter.id) {
    return false;
  }
  if (
    filter.sdtType !== undefined &&
    control.properties.sdtType !== filter.sdtType
  ) {
    return false;
  }
  return true;
}

function makeParagraphFromText(text: string): Paragraph {
  return {
    type: "paragraph",
    content:
      text.length === 0
        ? []
        : [{ type: "run", content: [{ type: "text", text }] }],
  };
}

function cloneBlock<T extends BlockContent>(block: T): T {
  return structuredClone(block);
}

/**
 * Replace a control's inner content. Plain text becomes one paragraph; an
 * explicit `BlockContent[]` is deep-cloned to preserve immutability. The
 * `showingPlcHdr` flag is cleared so the new content is not styled as
 * placeholder.
 */
export function setContentControlContent(
  doc: Document,
  filter: ContentControlFilter,
  input: SetContentControlContentInput,
  options: ForceOption = {},
): Document {
  const nextContent = transformBlocks(
    doc.package.document.content,
    (control) => {
      if (!controlMatchesFilter(control, filter)) {
        return undefined;
      }
      ensureContentNotLocked(control, options.force);
      const { strippedRawPropertiesXml } = ensureContentNotBound(
        control,
        options.force,
      );
      const blocks: BlockContent[] =
        typeof input === "string"
          ? [makeParagraphFromText(input)]
          : input.map(cloneBlock);
      const properties = { ...control.properties };
      properties.showingPlaceholder = false;
      if (strippedRawPropertiesXml !== undefined) {
        properties.rawPropertiesXml = strippedRawPropertiesXml;
      }
      return {
        ...control,
        properties,
        content: blocks,
      };
    },
  );
  return withUpdatedBody(doc, nextContent);
}

/**
 * Set a structured value on a typed control. Dropdown / checkbox / date
 * each get their own input shape so the input is type-checked at the
 * call site.
 */
export function setContentControlValue(
  doc: Document,
  filter: ContentControlFilter,
  input: SetContentControlValueInput,
  options: ForceOption = {},
): Document {
  const nextContent = transformBlocks(
    doc.package.document.content,
    (control) => {
      if (!controlMatchesFilter(control, filter)) {
        return undefined;
      }
      ensureContentNotLocked(control, options.force);
      const { strippedRawPropertiesXml } = ensureContentNotBound(
        control,
        options.force,
      );

      const sdtType = control.properties.sdtType;
      if (input.kind === "dropdown") {
        if (sdtType !== "dropdown" && sdtType !== "comboBox") {
          throw new ContentControlTypeError({
            message: `Cannot set dropdown value on a ${sdtType} control.`,
            sdtType,
            reason: "kind=dropdown requires sdtType=dropdown|comboBox",
            ...(control.properties.tag !== undefined
              ? { tag: control.properties.tag }
              : {}),
            ...(control.properties.alias !== undefined
              ? { alias: control.properties.alias }
              : {}),
          });
        }
        const items = control.properties.listItems ?? [];
        const item = items.find((i) => i.value === input.value);
        if (!item && !options.force) {
          throw new ContentControlTypeError({
            message: `Value "${input.value}" not in the control's list items.`,
            sdtType,
            reason: "value not in listItems",
            ...(control.properties.tag !== undefined
              ? { tag: control.properties.tag }
              : {}),
            ...(control.properties.alias !== undefined
              ? { alias: control.properties.alias }
              : {}),
          });
        }
        const display = item?.displayText ?? input.value;
        return {
          ...control,
          properties: {
            ...control.properties,
            dropdownLastValue: input.value,
            showingPlaceholder: false,
            ...(strippedRawPropertiesXml !== undefined
              ? { rawPropertiesXml: strippedRawPropertiesXml }
              : {}),
          },
          content: [makeParagraphFromText(display)],
        };
      }
      if (input.kind === "checkbox") {
        if (sdtType !== "checkbox") {
          throw new ContentControlTypeError({
            message: `Cannot toggle checkbox on a ${sdtType} control.`,
            sdtType,
            reason: "kind=checkbox requires sdtType=checkbox",
            ...(control.properties.tag !== undefined
              ? { tag: control.properties.tag }
              : {}),
            ...(control.properties.alias !== undefined
              ? { alias: control.properties.alias }
              : {}),
          });
        }
        const glyph = input.checked ? "☒" : "☐";
        return {
          ...control,
          properties: {
            ...control.properties,
            checked: input.checked,
            showingPlaceholder: false,
            ...(strippedRawPropertiesXml !== undefined
              ? { rawPropertiesXml: strippedRawPropertiesXml }
              : {}),
          },
          content: [makeParagraphFromText(glyph)],
        };
      }
      // date
      if (sdtType !== "date") {
        throw new ContentControlTypeError({
          message: `Cannot set date on a ${sdtType} control.`,
          sdtType,
          reason: "kind=date requires sdtType=date",
          ...(control.properties.tag !== undefined
            ? { tag: control.properties.tag }
            : {}),
          ...(control.properties.alias !== undefined
            ? { alias: control.properties.alias }
            : {}),
        });
      }
      // Keep the ISO value on the model and write the format-aware display
      // string into the body so the on-screen text and the OOXML
      // `w:fullDate` round-trip independently.
      const display = formatDateForSdtBody(
        input.date,
        control.properties.dateFormat,
      );
      return {
        ...control,
        properties: {
          ...control.properties,
          dateValueISO: input.date,
          showingPlaceholder: false,
          ...(strippedRawPropertiesXml !== undefined
            ? { rawPropertiesXml: strippedRawPropertiesXml }
            : {}),
        },
        content: [makeParagraphFromText(display)],
      };
    },
  );
  return withUpdatedBody(doc, nextContent);
}

/**
 * Remove a control. With `{ keepContent: true }` the inner blocks survive
 * in-place; otherwise the control and its children are dropped. Refuses to
 * unwrap a `w15:repeatingSection` (would orphan w15 row items).
 */
export function removeContentControl(
  doc: Document,
  filter: ContentControlFilter,
  options: ForceOption & { keepContent?: boolean } = {},
): Document {
  const nextContent = transformBlocks(
    doc.package.document.content,
    (control) => {
      if (!controlMatchesFilter(control, filter)) {
        return undefined;
      }
      ensureSdtNotLocked(control, options.force);
      if (options.keepContent) {
        if (isRepeatingSection(control) && !options.force) {
          throw new ContentControlTypeError({
            message:
              "Refusing to unwrap a w15:repeatingSection — would orphan its w15 row items.",
            sdtType: control.properties.sdtType,
            reason: "repeatingSection unwrap orphans items",
            ...(control.properties.tag !== undefined
              ? { tag: control.properties.tag }
              : {}),
            ...(control.properties.alias !== undefined
              ? { alias: control.properties.alias }
              : {}),
          });
        }
        return control.content;
      }
      // Drop control + content entirely.
      return null;
    },
  );
  // The body must contain at least one paragraph (OOXML requires a non-empty
  // body). Insert a placeholder if we just emptied it.
  if (nextContent.length === 0) {
    nextContent.push(makeParagraphFromText(""));
  }
  return withUpdatedBody(doc, nextContent);
}
