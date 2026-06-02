/**
 * Discover block-level content controls inside a `Document` model.
 *
 * Walks the document body recursively; an SDT inside another SDT or inside
 * a table cell is still found. Read-only — never mutates the input.
 *
 * Filters compose: pass any subset of `{ tag, alias, id, sdtType }` and
 * every supplied field must match. Omit a field to ignore it.
 */

import type {
  BlockContent,
  BlockSdt,
  Document,
  SdtProperties,
} from "../types/document";

export type ContentControlFilter = {
  tag?: string;
  alias?: string;
  /** OOXML numeric `w:id`. */
  id?: number;
  sdtType?: SdtProperties["sdtType"];
};

export type ContentControlMatch = {
  control: BlockSdt;
  /** Outer→inner stack of enclosing controls (empty when at the body root). */
  ancestry: BlockSdt[];
  /** Indices to walk back into the doc, outer→inner. */
  path: number[];
};

function matches(control: BlockSdt, filter: ContentControlFilter): boolean {
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

function walk(
  blocks: BlockContent[],
  filter: ContentControlFilter,
  out: ContentControlMatch[],
  ancestry: BlockSdt[],
  path: number[],
): void {
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (!block) {
      continue;
    }
    if (block.type === "blockSdt") {
      if (matches(block, filter)) {
        out.push({
          control: block,
          ancestry: [...ancestry],
          path: [...path, i],
        });
      }
      // Recurse into the SDT — nested SDTs are addressable too.
      walk(block.content, filter, out, [...ancestry, block], [...path, i]);
    } else if (block.type === "table") {
      // Walk into table cells so cell-level SDTs (where supported by the
      // parser) are surfaced too. cell.content is `(Paragraph | Table)[]`
      // today; the walker accepts the narrower type structurally because
      // it is a subset of BlockContent.
      for (let r = 0; r < block.rows.length; r += 1) {
        const row = block.rows[r];
        if (!row) {
          continue;
        }
        for (let c = 0; c < row.cells.length; c += 1) {
          const cell = row.cells[c];
          if (!cell) {
            continue;
          }
          walk(cell.content, filter, out, ancestry, [...path, i, r, c]);
        }
      }
    }
  }
}

export function findContentControls(
  doc: Document,
  filter: ContentControlFilter = {},
): ContentControlMatch[] {
  const out: ContentControlMatch[] = [];
  walk(doc.package.document.content, filter, out, [], []);
  return out;
}

export function findContentControl(
  doc: Document,
  filter: ContentControlFilter,
): ContentControlMatch | null {
  for (const match of findContentControls(doc, filter)) {
    return match;
  }
  return null;
}

/**
 * Concatenated plain text of every paragraph descendant inside a control,
 * separated by newlines. Useful for template/agent read paths.
 */
export function getContentControlText(control: BlockSdt): string {
  const parts: string[] = [];
  const visit = (blocks: BlockContent[]): void => {
    for (const block of blocks) {
      if (block.type === "paragraph") {
        const paraText: string[] = [];
        for (const item of block.content) {
          if (item.type === "run") {
            for (const child of item.content) {
              if (child.type === "text") {
                paraText.push(child.text);
              }
            }
          }
        }
        parts.push(paraText.join(""));
      } else if (block.type === "table") {
        for (const row of block.rows) {
          for (const cell of row.cells) {
            visit(cell.content);
          }
        }
      } else {
        // block.type === "blockSdt"
        visit(block.content);
      }
    }
  };
  visit(control.content);
  return parts.join("\n");
}
