import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseDocx } from "../parser";
import { repackDocx } from "../rezip";

const FIXTURE_PATH = join(
  import.meta.dir,
  "__fixtures__",
  "regressions",
  "repack-paragraph-sectpr.docx",
);

const readFixture = (): ArrayBuffer => {
  const bytes = readFileSync(FIXTURE_PATH);
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
};

const countParagraphSectPrs = (
  blocks: readonly { type: string; sectionProperties?: unknown }[],
): number =>
  blocks.filter(
    (b) => b.type === "paragraph" && b.sectionProperties !== undefined,
  ).length;

// Regression: paragraph-level `<w:pPr><w:sectPr/></w:pPr>` (an empty mid-body
// section break) was parsed but dropped on serialize, tripping the package
// fidelity guard. Fixture is a real-world contract from smlouvy.gov.cz that
// uses an empty paragraph-level sectPr.
describe("repack preserves paragraph-level section properties", () => {
  test("round-tripping the fixture does not drop the mid-body sectPr", async () => {
    const buf = readFixture();
    const doc = await parseDocx(buf);

    const originalParagraphSectPrs = countParagraphSectPrs(
      doc.package.document.content,
    );
    expect(originalParagraphSectPrs).toBeGreaterThan(0);

    const repacked = await repackDocx(doc, { updateModifiedDate: false });
    const reparsed = await parseDocx(repacked);

    expect(countParagraphSectPrs(reparsed.package.document.content)).toBe(
      originalParagraphSectPrs,
    );
  });
});
