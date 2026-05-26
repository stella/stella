import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import type { DocumentBody } from "../types/document";
import { parseDocx } from "./parser";
import { RELATIONSHIP_TYPES } from "./relsParser";
import { repackDocx } from "./rezip";
import { normalizeTrackedMoveRanges } from "./trackedMoveRangeNormalization";

const XML_DECLARATION =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

describe("normalizeTrackedMoveRanges", () => {
  test("removes unbalanced tracked move range markers", () => {
    const documentBody: DocumentBody = {
      content: [
        {
          type: "paragraph",
          content: [
            { type: "moveToRangeStart", id: 34, name: "moveA" },
            {
              type: "run",
              content: [{ type: "text", text: "Destination" }],
            },
            { type: "moveFromRangeStart", id: 60, name: "moveB" },
          ],
        },
      ],
    };

    const result = normalizeTrackedMoveRanges({ documentBody });

    expect(result).toEqual({
      removedUnbalancedMoveRangeMarkers: 2,
    });
    const paragraph = documentBody.content.at(0);
    expect(paragraph?.type).toBe("paragraph");
    if (paragraph?.type !== "paragraph") {
      throw new Error("Expected first block to be a paragraph");
    }
    expect(paragraph.content.map((content) => content.type)).toEqual(["run"]);
  });

  test("removes out-of-order tracked move range markers", () => {
    const documentBody: DocumentBody = {
      content: [
        {
          type: "paragraph",
          content: [
            { type: "moveFromRangeEnd", id: 8 },
            {
              type: "run",
              content: [{ type: "text", text: "Moved" }],
            },
            { type: "moveFromRangeStart", id: 8, name: "moveA" },
          ],
        },
      ],
    };

    const result = normalizeTrackedMoveRanges({ documentBody });

    expect(result).toEqual({
      removedUnbalancedMoveRangeMarkers: 2,
    });
    const paragraph = documentBody.content.at(0);
    expect(paragraph?.type).toBe("paragraph");
    if (paragraph?.type !== "paragraph") {
      throw new Error("Expected first block to be a paragraph");
    }
    expect(paragraph.content.map((content) => content.type)).toEqual(["run"]);
  });

  test("removes unbalanced tracked move range markers from comments", () => {
    const documentBody: DocumentBody = {
      content: [],
      comments: [
        {
          id: 1,
          author: "Reviewer",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "moveToRangeStart", id: 34, name: "moveA" },
                {
                  type: "run",
                  content: [{ type: "text", text: "Moved" }],
                },
              ],
            },
          ],
        },
      ],
    };

    const result = normalizeTrackedMoveRanges({ documentBody });

    expect(result).toEqual({
      removedUnbalancedMoveRangeMarkers: 1,
    });
    expect(
      documentBody.comments
        ?.at(0)
        ?.content.at(0)
        ?.content.map((content) => content.type),
    ).toEqual(["run"]);
  });

  test("parses and saves documents with unbalanced tracked move ranges", async () => {
    const buffer = await createUnbalancedMoveRangeFixture();
    const doc = await parseDocx(buffer, { preloadFonts: false });
    const block = doc.package.document.content.at(0);

    expect(block?.type).toBe("paragraph");
    if (block?.type !== "paragraph") {
      throw new Error("Expected first block to be a paragraph");
    }
    expect(block.content.map((content) => content.type)).toEqual(["run"]);
    expect(doc.warnings).toContain(
      "Removed 2 unbalanced tracked move range marker(s).",
    );

    const repacked = await repackDocx(doc, { updateModifiedDate: false });
    const zip = await JSZip.loadAsync(repacked);
    const documentXml = await zip.file("word/document.xml")?.async("string");

    expect(documentXml).not.toContain("moveFromRangeStart");
    expect(documentXml).not.toContain("moveToRangeStart");

    const reparsed = await parseDocx(repacked, { preloadFonts: false });
    expect(reparsed.warnings ?? []).not.toContain(
      "Removed 2 unbalanced tracked move range marker(s).",
    );
  });
});

const createUnbalancedMoveRangeFixture = async (): Promise<ArrayBuffer> => {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `${XML_DECLARATION}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `${XML_DECLARATION}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="${RELATIONSHIP_TYPES.officeDocument}" Target="word/document.xml"/>
</Relationships>`,
  );
  zip.file(
    "word/_rels/document.xml.rels",
    `${XML_DECLARATION}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`,
  );
  zip.file(
    "word/document.xml",
    `${XML_DECLARATION}
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:moveToRangeStart w:id="34" w:name="moveA"/>
      <w:r><w:t>Moved text</w:t></w:r>
      <w:moveFromRangeStart w:id="60" w:name="moveB"/>
    </w:p>
  </w:body>
</w:document>`,
  );
  return zip.generateAsync({ type: "arraybuffer" });
};
