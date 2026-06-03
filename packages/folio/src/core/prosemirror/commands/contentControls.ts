/**
 * ProseMirror transaction helpers for the block-level content controls API.
 *
 * Each helper finds the target `blockSdt` PM node, mutates the doc via a
 * normal transaction, and returns it so the caller can dispatch (writes are
 * undoable and suggestion-mode-safe via `isHistoryTransaction`). The
 * headless helpers in `core/content-controls/` are the source of truth for
 * lock / type validation; we re-implement the search here because we need to
 * walk PM nodes (not the Document model).
 */

import type { Node as PMNode, Schema } from "prosemirror-model";
import type { EditorState, Transaction } from "prosemirror-state";

import type {
  ContentControlFilter,
  SetContentControlContentInput,
  SetContentControlValueInput,
} from "../../content-controls";
import {
  ContentControlLockedError,
  ContentControlTypeError,
} from "../../content-controls/errors";
import { formatDate } from "../../docx/fieldParser";
import type { SdtProperties } from "../../types/document";
import { expectBlockSdtAttrs } from "../attrs";
import { SUGGESTION_BYPASS_META } from "../plugins/suggestionMode";

type ForceOption = { force?: boolean };

export type BlockSdtPMMatch = {
  node: PMNode;
  /** Absolute PM position of the blockSdt's open tag. */
  pos: number;
  /** Outer→inner index path through doc children. */
  path: number[];
};

function nodeMatchesFilter(
  node: PMNode,
  pos: number,
  filter: ContentControlFilter,
): boolean {
  if (node.type.name !== "blockSdt") {
    return false;
  }
  // pmPos addresses one specific control instance — use it first so the
  // widgets plugin (which derives the position from the clicked anchor)
  // never has to disambiguate between SDTs that share a tag/alias.
  if (filter.pmPos !== undefined && pos !== filter.pmPos) {
    return false;
  }
  const attrs = node.attrs;
  if (filter.tag !== undefined && attrs["tag"] !== filter.tag) {
    return false;
  }
  if (filter.alias !== undefined && attrs["alias"] !== filter.alias) {
    return false;
  }
  if (filter.id !== undefined && attrs["id"] !== filter.id) {
    return false;
  }
  if (filter.sdtType !== undefined && attrs["sdtType"] !== filter.sdtType) {
    return false;
  }
  return true;
}

/** All blockSdt nodes in `doc` matching `filter`. Outer→inner traversal. */
export function findBlockSdtMatches(
  doc: PMNode,
  filter: ContentControlFilter = {},
): BlockSdtPMMatch[] {
  const matches: BlockSdtPMMatch[] = [];
  doc.descendants((node, pos, _parent, index) => {
    if (node.type.name !== "blockSdt") {
      return true;
    }
    if (nodeMatchesFilter(node, pos, filter)) {
      matches.push({ node, pos, path: [...resolvePath(doc, pos), index] });
    }
    return true;
  });
  return matches;
}

/** First match or null — convenience for editor-ref callers. */
export function findBlockSdtMatch(
  doc: PMNode,
  filter: ContentControlFilter,
): BlockSdtPMMatch | null {
  for (const match of findBlockSdtMatches(doc, filter)) {
    return match;
  }
  return null;
}

function resolvePath(doc: PMNode, pos: number): number[] {
  const $pos = doc.resolve(pos);
  const path: number[] = [];
  for (let depth = 1; depth <= $pos.depth; depth += 1) {
    path.push($pos.index(depth - 1));
  }
  return path;
}

/**
 * Project a `blockSdt` PM node's attrs onto the full modeled `SdtProperties`
 * shape so the editor-ref `getContentControls` and lock-error messages
 * surface every field downstream tooling expects (lock, placeholder,
 * dateFormat, listItems, checked, etc.). Raw XML payloads are not exposed —
 * those are for serializer replay, not for callers.
 */
export function blockSdtAttrsToSdtProperties(node: PMNode): SdtProperties {
  const attrs = expectBlockSdtAttrs(node);
  const props: SdtProperties = { sdtType: attrs.sdtType };
  if (attrs.alias !== undefined) {
    props.alias = attrs.alias;
  }
  if (attrs.tag !== undefined) {
    props.tag = attrs.tag;
  }
  if (typeof attrs.id === "number") {
    props.id = attrs.id;
  }
  if (attrs.lock !== undefined) {
    props.lock = attrs.lock;
  }
  if (attrs.placeholder !== undefined) {
    props.placeholder = attrs.placeholder;
  }
  if (attrs.showingPlaceholder !== undefined) {
    props.showingPlaceholder = attrs.showingPlaceholder;
  }
  if (attrs.dateFormat !== undefined) {
    props.dateFormat = attrs.dateFormat;
  }
  if (attrs.dateValueISO !== undefined) {
    props.dateValueISO = attrs.dateValueISO;
  }
  if (attrs.listItems) {
    const parsed = parseListItemsAttr(attrs.listItems);
    if (parsed) {
      props.listItems = parsed;
    }
  }
  if (typeof attrs.dropdownLastValue === "string") {
    props.dropdownLastValue = attrs.dropdownLastValue;
  }
  if (typeof attrs.checked === "boolean") {
    props.checked = attrs.checked;
  }
  return props;
}

function parseListItemsAttr(
  raw: string,
): { displayText: string; value: string }[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return null;
    }
    const items: { displayText: string; value: string }[] = [];
    for (const entry of parsed) {
      if (
        entry !== null &&
        typeof entry === "object" &&
        "displayText" in entry &&
        "value" in entry &&
        typeof (entry as { displayText: unknown }).displayText === "string" &&
        typeof (entry as { value: unknown }).value === "string"
      ) {
        items.push(entry as { displayText: string; value: string });
      }
    }
    return items.length > 0 ? items : null;
  } catch {
    return null;
  }
}

function attrsToProperties(node: PMNode): SdtProperties {
  // Used only for lock-error messages; keep the projection minimal so the
  // error path does not pull through the full attrs reader.
  const attrs = node.attrs;
  const sdtType = String(
    attrs["sdtType"] ?? "richText",
  ) as SdtProperties["sdtType"];
  const props: SdtProperties = { sdtType };
  if (attrs["alias"]) {
    props.alias = String(attrs["alias"]);
  }
  if (attrs["tag"]) {
    props.tag = String(attrs["tag"]);
  }
  if (typeof attrs["id"] === "number") {
    props.id = attrs["id"];
  }
  return props;
}

function throwLockedNode(
  node: PMNode,
  lock: NonNullable<SdtProperties["lock"]>,
): never {
  const props = attrsToProperties(node);
  throw new ContentControlLockedError({
    message: `Control "${props.tag ?? props.alias ?? "(unnamed)"}" has w:lock=${lock}.`,
    lock,
    ...(props.tag !== undefined ? { tag: props.tag } : {}),
    ...(props.alias !== undefined ? { alias: props.alias } : {}),
  });
}

/**
 * Per OOXML §17.5.2.16: `contentLocked` and `sdtContentLocked` block
 * content edits; `sdtLocked` does NOT (it only forbids container
 * removal). Mirrors the headless `ensureContentNotLocked` helper.
 */
function ensureContentNotLocked(node: PMNode, options: ForceOption): void {
  if (options.force) {
    return;
  }
  const lock = node.attrs["lock"];
  if (lock === "contentLocked" || lock === "sdtContentLocked") {
    throwLockedNode(node, lock);
  }
}

/**
 * Per OOXML §17.5.2.16: `sdtLocked` and `sdtContentLocked` block container
 * removal; `contentLocked` does NOT (it only forbids content edits).
 */
function ensureSdtNotLocked(node: PMNode, options: ForceOption): void {
  if (options.force) {
    return;
  }
  const lock = node.attrs["lock"];
  if (lock === "sdtLocked" || lock === "sdtContentLocked") {
    throwLockedNode(node, lock);
  }
}

function paragraphFromText(schema: Schema, text: string): PMNode {
  if (text.length === 0) {
    return schema.node("paragraph", {}, []);
  }
  return schema.node("paragraph", {}, [schema.text(text)]);
}

function replaceBlockSdtChildren(
  state: EditorState,
  match: BlockSdtPMMatch,
  children: readonly PMNode[],
  propertyOverrides: Partial<Record<string, unknown>> = {},
): Transaction {
  const next = state.schema.node(
    "blockSdt",
    { ...match.node.attrs, showingPlaceholder: false, ...propertyOverrides },
    children.length === 0 ? [paragraphFromText(state.schema, "")] : children,
  );
  // Tag the transaction so suggestion mode's catch-all appendTransaction
  // does NOT stamp insertion marks on the new body content. A content
  // control widget interaction is a typed write against the SDT's state,
  // not a tracked edit by the user — the same reason undoing a tracked
  // Enter does not mark the rejoined text as inserted.
  return state.tr
    .replaceWith(match.pos, match.pos + match.node.nodeSize, next)
    .setMeta(SUGGESTION_BYPASS_META, true);
}

/**
 * Replace a control's children with plain text (one paragraph) or
 * pre-built PM blocks. Returns null when no match is present.
 */
export function setContentControlContentTr(
  state: EditorState,
  filter: ContentControlFilter,
  input: SetContentControlContentInput,
  options: ForceOption = {},
): Transaction | null {
  const match = findBlockSdtMatch(state.doc, filter);
  if (!match) {
    return null;
  }
  ensureContentNotLocked(match.node, options);

  if (typeof input !== "string") {
    // Block-content fill is supported via `setContentControlContentBlocksTr`
    // (separate module to avoid a cycle: the conversion pipeline imports
    // the schema, which transitively imports the widgets plugin, which
    // imports this module). Refuse early with a clear message instead of
    // silently coercing.
    throw new ContentControlTypeError({
      message:
        "Block-content fill must go through `setContentControlContentBlocksTr` (avoids a schema/plugin import cycle); pass a string here.",
      sdtType: (match.node.attrs["sdtType"] ??
        "richText") as SdtProperties["sdtType"],
      reason: "PM-direct path takes string input only",
    });
  }
  return replaceBlockSdtChildren(state, match, [
    paragraphFromText(state.schema, input),
  ]);
}

/**
 * Internal helper for the block-content fill variant. Lives in this module
 * so callers reuse the same lock-check and `replaceWith` shape; the
 * conversion-aware `setContentControlContentBlocksTr` in
 * `./contentControlsBlockFill.ts` wraps it.
 */
export function replaceBlockSdtChildrenForFill(
  state: EditorState,
  filter: ContentControlFilter,
  children: readonly PMNode[],
  options: ForceOption = {},
): Transaction | null {
  const match = findBlockSdtMatch(state.doc, filter);
  if (!match) {
    return null;
  }
  ensureContentNotLocked(match.node, options);
  return replaceBlockSdtChildren(state, match, children);
}

export function setContentControlValueTr(
  state: EditorState,
  filter: ContentControlFilter,
  input: SetContentControlValueInput,
  options: ForceOption = {},
): Transaction | null {
  const match = findBlockSdtMatch(state.doc, filter);
  if (!match) {
    return null;
  }
  ensureContentNotLocked(match.node, options);

  const sdtType = match.node.attrs["sdtType"] as SdtProperties["sdtType"];

  if (input.kind === "dropdown") {
    if (sdtType !== "dropdown" && sdtType !== "comboBox") {
      throw new ContentControlTypeError({
        message: `Cannot set dropdown value on a ${sdtType} control.`,
        sdtType,
        reason: "kind=dropdown requires sdtType=dropdown|comboBox",
      });
    }
    const listItemsAttr = match.node.attrs["listItems"];
    let display = input.value;
    if (typeof listItemsAttr === "string" && listItemsAttr) {
      // Guard against malformed listItems JSON (extension code that
      // mutated the attr, schema drift). A bare `JSON.parse` would crash
      // the transaction; treat malformed input as "no list" and fall
      // back to writing the raw value with no displayText lookup.
      let items: { displayText: string; value: string }[] | null = null;
      try {
        const parsed: unknown = JSON.parse(listItemsAttr);
        if (Array.isArray(parsed)) {
          items = parsed as { displayText: string; value: string }[];
        }
      } catch {
        items = null;
      }
      const item = items?.find((i) => i.value === input.value);
      if (!item && !options.force && items !== null) {
        throw new ContentControlTypeError({
          message: `Value "${input.value}" not in the control's list items.`,
          sdtType,
          reason: "value not in listItems",
        });
      }
      if (item) {
        display = item.displayText;
      }
    }
    return replaceBlockSdtChildren(
      state,
      match,
      [paragraphFromText(state.schema, display)],
      // Persist the picked OOXML value separately so duplicate-label items
      // round-trip to the right selection on save — the serializer reads
      // dropdownLastValue before falling back to display-text matching.
      { dropdownLastValue: input.value },
    );
  }
  if (input.kind === "checkbox") {
    if (sdtType !== "checkbox") {
      throw new ContentControlTypeError({
        message: `Cannot toggle checkbox on a ${sdtType} control.`,
        sdtType,
        reason: "kind=checkbox requires sdtType=checkbox",
      });
    }
    const glyph = input.checked ? "☒" : "☐";
    return replaceBlockSdtChildren(
      state,
      match,
      [paragraphFromText(state.schema, glyph)],
      {
        checked: input.checked,
      },
    );
  }
  if (sdtType !== "date") {
    throw new ContentControlTypeError({
      message: `Cannot set date on a ${sdtType} control.`,
      sdtType,
      reason: "kind=date requires sdtType=date",
    });
  }
  // Keep the ISO value on `dateValueISO` and render the format-aware
  // display string into the body — `w:fullDate` is the bound value, the
  // body text is what Word shows. Mirrors the headless setter.
  const dateFormatAttr = match.node.attrs["dateFormat"];
  const display = formatDateForBody(
    input.date,
    typeof dateFormatAttr === "string" ? dateFormatAttr : undefined,
  );
  return replaceBlockSdtChildren(
    state,
    match,
    [paragraphFromText(state.schema, display)],
    { dateValueISO: input.date },
  );
}

function formatDateForBody(
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
 * See `formatDateForSdtBody` in the headless helpers for the rationale.
 * Supports date-only (`YYYY-MM-DD`) and date+time
 * (`YYYY-MM-DDTHH:mm[:ss]`) inputs, building a local-time Date so
 * `formatDate`'s accessors return the picked wall-clock components
 * regardless of TZ.
 */
// See headless helper for the rationale on the regex shape — in
// particular the optional fractional-seconds group.
const SDT_DATE_RE =
  // oxlint-disable-next-line sonarjs/regex-complexity -- mirrors headless helper
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
    // See headless helper: JS silently normalizes overflow components;
    // reject the parse when the result disagrees with what was asked for.
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

function isRepeatingSection(node: PMNode): boolean {
  // Match by local name so an alt-prefix `<ns0:repeatingSection/>` is
  // recognized too (the headless helper has the same fix).
  const raw = node.attrs["rawPropertiesXml"];
  return typeof raw === "string" && /<\w+:repeatingSection\b/u.test(raw);
}

export function removeContentControlTr(
  state: EditorState,
  filter: ContentControlFilter,
  options: ForceOption & { keepContent?: boolean } = {},
): Transaction | null {
  const match = findBlockSdtMatch(state.doc, filter);
  if (!match) {
    return null;
  }
  ensureSdtNotLocked(match.node, options);

  if (options.keepContent) {
    if (isRepeatingSection(match.node) && !options.force) {
      throw new ContentControlTypeError({
        message:
          "Refusing to unwrap a w15:repeatingSection — would orphan its w15 row items.",
        sdtType: (match.node.attrs["sdtType"] ??
          "richText") as SdtProperties["sdtType"],
        reason: "repeatingSection unwrap orphans items",
      });
    }
    // Replace the SDT with its children in place.
    const children: PMNode[] = [];
    for (let i = 0; i < match.node.childCount; i += 1) {
      children.push(match.node.child(i));
    }
    return state.tr
      .replaceWith(match.pos, match.pos + match.node.nodeSize, children)
      .setMeta(SUGGESTION_BYPASS_META, true);
  }
  // Drop entirely. DocExtension requires `+` at the doc root, and any
  // `block+` container (notably a parent blockSdt) would likewise
  // become invalid if we removed its sole child without substituting a
  // block. Substitute an empty paragraph whenever the target is the
  // ONLY child of its parent, regardless of whether the parent is the
  // doc root or another blockSdt — the headless `removeContentControl`
  // already does this for the same case.
  const $pos = state.doc.resolve(match.pos);
  const parent = $pos.parent;
  if (parent.childCount === 1) {
    return state.tr
      .replaceWith(
        match.pos,
        match.pos + match.node.nodeSize,
        paragraphFromText(state.schema, ""),
      )
      .setMeta(SUGGESTION_BYPASS_META, true);
  }
  return state.tr
    .delete(match.pos, match.pos + match.node.nodeSize)
    .setMeta(SUGGESTION_BYPASS_META, true);
}
