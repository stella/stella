import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type {
  BlockContent,
  Document,
  Paragraph,
  Run,
} from "../../types/document";
import { parseDocx } from "../parser";
import { repackDocx } from "../rezip";

/**
 * Regression: parseDocx → repackDocx → parseDocx must be count-stable on a
 * real-world contract (anonymised, from smlouvy.gov.cz) that contains text-box
 * shapes (wps:wsp + wps:txbx) inside runs that hold no other content.
 *
 * Before the fix, runConsolidator dropped those runs because parseImage skipped
 * the text-box drawing, leaving enrichParagraphTextBoxes unable to attach the
 * resulting shape. The serializer then re-emitted the shape as a `<w:drawing>`
 * with no `<wps:txbx>` (because shapeType was "rect", not "textBox"), so the
 * next parse counted the now-bare shapes as plain drawings.
 */

const FIXTURE_PATH = join(
  import.meta.dir,
  "__fixtures__/regressions/repack-image-count.docx",
);

function countDrawings(doc: Document): number {
  let total = 0;

  const visitRun = (run: Run): void => {
    for (const content of run.content) {
      if (content.type === "drawing") {
        total += 1;
      }
    }
  };

  const visitParagraph = (paragraph: Paragraph): void => {
    for (const node of paragraph.content) {
      if (node.type === "run") {
        visitRun(node);
      } else if (node.type === "hyperlink") {
        for (const child of node.children) {
          if (child.type === "run") {
            visitRun(child);
          }
        }
      }
    }
  };

  const visitBlock = (block: BlockContent): void => {
    if (block.type === "paragraph") {
      visitParagraph(block);
      return;
    }
    if (block.type === "table") {
      for (const row of block.rows) {
        for (const cell of row.cells) {
          for (const inner of cell.content) {
            visitBlock(inner);
          }
        }
      }
      return;
    }
    for (const inner of block.content) {
      visitBlock(inner);
    }
  };

  for (const block of doc.package.document.content) {
    visitBlock(block);
  }
  return total;
}

test("repackDocx preserves drawing count across round-trip for textbox-heavy contracts", async () => {
  const bytes = readFileSync(FIXTURE_PATH);
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );

  const first = await parseDocx(buffer, { preloadFonts: false });
  const before = countDrawings(first);

  const repacked = await repackDocx(first, { updateModifiedDate: false });
  const second = await parseDocx(repacked, { preloadFonts: false });
  const after = countDrawings(second);

  expect(after).toBe(before);
});
