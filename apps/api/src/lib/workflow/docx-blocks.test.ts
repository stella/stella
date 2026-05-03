import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { extractFolioBlocksFromDocxBuffer } from "@/api/lib/workflow/docx-blocks";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const MC_NS = "http://schemas.openxmlformats.org/markup-compatibility/2006";

const buildDocxBuffer = async (documentXml: string): Promise<ArrayBuffer> => {
  const zip = new JSZip();
  zip.file("word/document.xml", documentXml);
  const bytes = await zip.generateAsync({ type: "uint8array" });
  // Copy into a fresh ArrayBuffer so the result is plain (not
  // SharedArrayBuffer-typed) and detached from the source.
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
};

const wrap = (
  body: string,
) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W_NS}" xmlns:mc="${MC_NS}">
  <w:body>${body}</w:body>
</w:document>`;

describe("extractFolioBlocksFromDocxBuffer", () => {
  // Regression for PR #56 review feedback: tracked-change DELETIONS
  // (`w:moveFrom`, `w:del`) must NOT contribute to the extracted text
  // — only the "final" view of the document (the moveTo / ins side)
  // counts.
  test("skips tracked-change deletions", async () => {
    const buffer = await buildDocxBuffer(
      wrap(`
        <w:p>
          <w:r><w:t>Kept </w:t></w:r>
          <w:moveFrom>
            <w:r><w:t>OLD</w:t></w:r>
          </w:moveFrom>
          <w:moveTo>
            <w:r><w:t>NEW</w:t></w:r>
          </w:moveTo>
          <w:del>
            <w:r><w:delText>DELETED</w:delText></w:r>
          </w:del>
          <w:ins>
            <w:r><w:t> inserted</w:t></w:r>
          </w:ins>
        </w:p>
      `),
    );

    const blocks = await extractFolioBlocksFromDocxBuffer(buffer);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe("Kept NEW inserted");
  });

  // Regression for PR #56 review feedback: only one branch of
  // `w:alternateContent` should contribute. Visiting both branches
  // would emit the same paragraph text twice for compatibility-
  // wrapped content (e.g. drawings with a fallback shape).
  test("emits the alternateContent choice branch only", async () => {
    const buffer = await buildDocxBuffer(
      wrap(`
        <w:p>
          <mc:AlternateContent>
            <mc:Choice Requires="w14">
              <w:r><w:t>preferred</w:t></w:r>
            </mc:Choice>
            <mc:Fallback>
              <w:r><w:t>legacy</w:t></w:r>
            </mc:Fallback>
          </mc:AlternateContent>
        </w:p>
      `),
    );

    const blocks = await extractFolioBlocksFromDocxBuffer(buffer);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe("preferred");
  });
});
