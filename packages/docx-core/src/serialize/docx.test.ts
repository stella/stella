import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import type { Document, Table } from "../model/document";
import { serializeDocumentToDocx } from "./docx";

const docWithBorder = (style: string, rgb: string): Document => {
  const table: Table = {
    type: "table",
    rows: [
      {
        type: "tableRow",
        cells: [
          {
            type: "tableCell",
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "run",
                    content: [{ type: "text", text: "x" }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    formatting: {
      borders: { top: { style, size: 4, color: { rgb } } },
    },
  };

  return {
    package: {
      document: {
        content: [table],
      },
    },
  };
};

const readDocumentXml = async (buf: ArrayBuffer): Promise<string> => {
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file("word/document.xml")?.async("string");
  if (xml === undefined) {
    throw new Error("word/document.xml missing from serialized docx");
  }
  return xml;
};

describe("DOCX border serialization escapes attribute values", () => {
  test("a style value cannot inject extra XML attributes", async () => {
    const xml = await readDocumentXml(
      await serializeDocumentToDocx(
        docWithBorder('single" w:evil="1', "CCCCCC"),
      ),
    );
    // The injected attribute must not appear as a real attribute, and the
    // quote must be entity-escaped.
    expect(xml).not.toContain('w:evil="1"');
    expect(xml).toContain("&quot;");
  });

  test("a color value cannot break out of its attribute", async () => {
    const xml = await readDocumentXml(
      await serializeDocumentToDocx(docWithBorder("single", 'FF0000" x="y')),
    );
    expect(xml).not.toContain('x="y"');
    expect(xml).toContain("&quot;");
  });

  test("ordinary border values serialize unescaped", async () => {
    const xml = await readDocumentXml(
      await serializeDocumentToDocx(docWithBorder("single", "CCCCCC")),
    );
    expect(xml).toContain('w:val="single"');
    expect(xml).toContain('w:color="CCCCCC"');
  });
});
