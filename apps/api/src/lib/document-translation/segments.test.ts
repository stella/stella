import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import {
  applyDocxTranslationSegments,
  DocxTranslationError,
  extractDocxTranslationSegments,
} from "./segments";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

const part = (body: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}</w:body></w:document>`;

const createDocx = async (
  parts: Readonly<Record<string, string>>,
): Promise<ArrayBuffer> => {
  const zip = new JSZip();
  for (const [path, value] of Object.entries(parts)) {
    zip.file(path, value);
  }
  return await zip.generateAsync({ type: "arraybuffer" });
};

const readEntry = async (
  buffer: ArrayBuffer,
  path: string,
): Promise<string> => {
  const zip = await JSZip.loadAsync(buffer);
  const entry = zip.file(path);
  if (!entry) {
    throw new Error(`Missing ${path}`);
  }
  return await entry.async("string");
};

const translateAll = async (
  input: ArrayBuffer,
  transform: (text: string, segmentIndex: number) => string = (text) =>
    text.toUpperCase(),
): Promise<ArrayBuffer> => {
  const document = await extractDocxTranslationSegments(input);
  return await applyDocxTranslationSegments(
    input,
    document.segments.map((segment, index) => ({
      segmentId: segment.segmentId,
      taggedText: segment.runs
        .map(
          (run) =>
            `[[stella-translation:${run.markerId}]]${transform(run.text, index)}[[/stella-translation:${run.markerId}]]`,
        )
        .join(""),
    })),
  );
};

describe("DOCX translation segments", () => {
  test("extracts stable XML-decoded runs from body, table, and related parts", async () => {
    const input = await createDocx({
      "word/document.xml": part(
        '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>A &amp; </w:t></w:r><w:hyperlink r:id="rId1"><w:r><w:t>link</w:t></w:r></w:hyperlink></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
      ),
      "word/header1.xml": part("<w:p><w:r><w:t>Header</w:t></w:r></w:p>"),
      "word/footer1.xml": part("<w:p><w:r><w:t>Footer</w:t></w:r></w:p>"),
      "word/footnotes.xml": part("<w:p><w:r><w:t>Footnote</w:t></w:r></w:p>"),
      "word/endnotes.xml": part("<w:p><w:r><w:t>Endnote</w:t></w:r></w:p>"),
      "word/media/image.bin": "unchanged-binary-content",
    });

    const document = await extractDocxTranslationSegments(input);
    expect(document.segments.map((segment) => segment.text)).toEqual([
      "A & link",
      "Cell",
      "Endnote",
      "Footer",
      "Footnote",
      "Header",
    ]);
    expect(document.segments.at(0)?.taggedText).toContain("A & ");
    expect(document.segments.at(0)?.runs).toHaveLength(2);
    expect(document.segments.at(0)?.segmentId).toBe(
      "word/document.xml:p000001",
    );
  });

  test("does not expose field instructions or deleted text as translation input", async () => {
    const input = await createDocx({
      "word/document.xml": part(
        "<w:p><w:r><w:instrText>PAGE</w:instrText></w:r><w:r><w:delText>old</w:delText></w:r><w:r><w:t>visible</w:t></w:r></w:p>",
      ),
    });
    const document = await extractDocxTranslationSegments(input);
    expect(document.segments.map((segment) => segment.text)).toEqual([
      "visible",
    ]);
  });

  test("patches only w:t contents and retains run formatting and other entries", async () => {
    const input = await createDocx({
      "word/document.xml": part(
        '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>A &amp; </w:t></w:r><w:hyperlink r:id="rId1"><w:r><w:t>link</w:t></w:r></w:hyperlink></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
      ),
      "word/header1.xml": part("<w:p><w:r><w:t>Header</w:t></w:r></w:p>"),
      "word/footnotes.xml": part("<w:p><w:r><w:t>Footnote</w:t></w:r></w:p>"),
      "word/media/image.bin": "unchanged-binary-content",
    });
    const output = await translateAll(input, (text) => `é<${text}>`);
    const xml = await readEntry(output, "word/document.xml");
    expect(xml).toContain("<w:b/>");
    expect(xml).toContain('r:id="rId1"');
    expect(xml).toContain("é&lt;A &amp; &gt;");
    expect(xml).toContain("é&lt;link&gt;");
    expect(xml).toContain("é&lt;cell&gt;");
    expect(await readEntry(output, "word/media/image.bin")).toBe(
      "unchanged-binary-content",
    );
    expect(await readEntry(output, "word/header1.xml")).toContain(
      "é&lt;Header&gt;",
    );
    expect(await readEntry(output, "word/footnotes.xml")).toContain(
      "é&lt;Footnote&gt;",
    );
  });

  test("rejects tracked changes and comments before exposing source text", async () => {
    const tracked = await createDocx({
      "word/document.xml": part(
        '<w:ins w:id="1"><w:p><w:r><w:t>hidden</w:t></w:r></w:p></w:ins>',
      ),
    });
    expect(extractDocxTranslationSegments(tracked)).rejects.toBeInstanceOf(
      DocxTranslationError,
    );

    const comments = await createDocx({
      "word/document.xml": part("<w:p><w:r><w:t>source</w:t></w:r></w:p>"),
      "word/comments.xml": part('<w:comment w:id="1"/>'),
    });
    expect(extractDocxTranslationSegments(comments)).rejects.toThrow(
      "tracked changes or comments",
    );
  });

  test("rejects missing, duplicate, and reordered model markers", async () => {
    const input = await createDocx({
      "word/document.xml": part(
        "<w:p><w:r><w:t>one</w:t></w:r><w:r><w:t>two</w:t></w:r></w:p>",
      ),
    });
    const document = await extractDocxTranslationSegments(input);
    const segment = document.segments.at(0);
    if (!segment) {
      throw new Error("Expected one segment");
    }
    const marker = (index: number) => {
      const run = segment.runs.at(index);
      if (!run) {
        throw new Error(`Expected run ${index}`);
      }
      return `[[stella-translation:${run.markerId}]]x[[/stella-translation:${run.markerId}]]`;
    };
    for (const taggedText of [
      marker(0),
      `${marker(0)}${marker(0)}`,
      `${marker(1)}${marker(0)}`,
    ]) {
      expect(
        applyDocxTranslationSegments(input, [
          { segmentId: segment.segmentId, taggedText },
        ]),
      ).rejects.toThrow("marker");
    }
  });
});
