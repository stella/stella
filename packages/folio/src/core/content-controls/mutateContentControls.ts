/**
 * Pure (immutable) write helpers for block-level content controls.
 *
 * Each helper returns a brand-new `Document` with the requested mutation
 * applied; the original document is never touched. Locked controls and
 * type-incompatible operations throw a tagged error unless `{ force: true }`
 * is passed. `w15:repeatingSection` controls cannot be unwrapped — doing so
 * would orphan their w15 row items.
 */

import type {
  BlockContent,
  BlockSdt,
  Document,
  Paragraph,
  Table,
} from "../types/document";
import { ContentControlLockedError, ContentControlTypeError } from "./errors";
import type { ContentControlFilter } from "./findContentControls";

type ForceOption = { force?: boolean };

export type SetContentControlContentInput = string | BlockContent[];

export type SetContentControlValueInput =
  | { kind: "dropdown"; value: string }
  | { kind: "checkbox"; checked: boolean }
  | { kind: "date"; date: string };

function lockBlocksMutation(
  control: BlockSdt,
  force: boolean | undefined,
): void {
  const lock = control.properties.lock;
  if (force) {
    return;
  }
  if (lock === "contentLocked" || lock === "sdtContentLocked") {
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
}

function isRepeatingSection(control: BlockSdt): boolean {
  // Not modeled in folio's SdtType enum; detected via the captured raw XML.
  return Boolean(
    control.properties.rawPropertiesXml?.includes("w15:repeatingSection"),
  );
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
    return { ...block, content: nextContent };
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
      lockBlocksMutation(control, options.force);
      const blocks: BlockContent[] =
        typeof input === "string"
          ? [makeParagraphFromText(input)]
          : input.map(cloneBlock);
      const properties = { ...control.properties };
      properties.showingPlaceholder = false;
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
      lockBlocksMutation(control, options.force);

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
          properties: { ...control.properties, showingPlaceholder: false },
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
      return {
        ...control,
        properties: { ...control.properties, showingPlaceholder: false },
        content: [makeParagraphFromText(input.date)],
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
      lockBlocksMutation(control, options.force);
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
