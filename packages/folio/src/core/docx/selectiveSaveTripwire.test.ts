/**
 * Unit tests for the selective-save tripwire byte comparison.
 *
 * The tripwire only observes — it never blocks a save. Its job is to flag
 * divergence between the selective and full save paths so CI / observability
 * can act on it.
 */

import { describe, test, expect } from "bun:test";
import JSZip from "jszip";

import { compareSelectiveVsFull } from "./selectiveSaveTripwire";

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

async function makeZip(
  entries: Record<string, string | Uint8Array>,
): Promise<ArrayBuffer> {
  const zip = new JSZip();
  for (const [path, data] of Object.entries(entries)) {
    zip.file(path, data);
  }
  return zip.generateAsync({ type: "arraybuffer" });
}

const SHARED_ENTRIES = {
  "[Content_Types].xml": `${XML_DECL}<Types/>`,
  "_rels/.rels": `${XML_DECL}<Relationships/>`,
  "word/document.xml": `${XML_DECL}<doc>same</doc>`,
};

describe("compareSelectiveVsFull", () => {
  test("returns `selective-skipped` when selective bytes are null", async () => {
    const full = await makeZip(SHARED_ENTRIES);
    const result = await compareSelectiveVsFull(null, full);
    expect(result.kind).toBe("selective-skipped");
    if (result.kind === "selective-skipped") {
      expect(result.reason).toBe("selective-returned-null");
    }
  });

  test("returns `match` for two zips with identical entry sets and bytes", async () => {
    const a = await makeZip(SHARED_ENTRIES);
    const b = await makeZip(SHARED_ENTRIES);
    const result = await compareSelectiveVsFull(a, b);
    expect(result.kind).toBe("match");
  });

  test("ignores `docProps/core.xml` differences (both paths refresh dcterms:modified)", async () => {
    const a = await makeZip({
      ...SHARED_ENTRIES,
      "docProps/core.xml": `${XML_DECL}<core><modified>A</modified></core>`,
    });
    const b = await makeZip({
      ...SHARED_ENTRIES,
      "docProps/core.xml": `${XML_DECL}<core><modified>B</modified></core>`,
    });
    const result = await compareSelectiveVsFull(a, b);
    expect(result.kind).toBe("match");
  });

  test("reports `entry-set-diff` when paths only appear in one side", async () => {
    const a = await makeZip({
      ...SHARED_ENTRIES,
      "word/comments.xml": "<comments/>",
    });
    const b = await makeZip({
      ...SHARED_ENTRIES,
      "word/footnotes.xml": "<footnotes/>",
    });
    const result = await compareSelectiveVsFull(a, b);
    expect(result.kind).toBe("entry-set-diff");
    if (result.kind === "entry-set-diff") {
      expect(result.onlyInSelective).toContain("word/comments.xml");
      expect(result.onlyInFull).toContain("word/footnotes.xml");
    }
  });

  test("reports `entry-byte-diff` when a shared entry's bytes differ", async () => {
    const a = await makeZip({
      ...SHARED_ENTRIES,
      "word/document.xml": `${XML_DECL}<doc>alpha</doc>`,
    });
    const b = await makeZip({
      ...SHARED_ENTRIES,
      "word/document.xml": `${XML_DECL}<doc>beta_____</doc>`,
    });
    const result = await compareSelectiveVsFull(a, b);
    expect(result.kind).toBe("entry-byte-diff");
    if (result.kind === "entry-byte-diff") {
      expect(result.path).toBe("word/document.xml");
      expect(result.selectiveSize).not.toBe(result.fullSize);
    }
  });

  test("`match` survives different file insertion order in the zip", async () => {
    const a = new JSZip();
    a.file("[Content_Types].xml", SHARED_ENTRIES["[Content_Types].xml"]);
    a.file("_rels/.rels", SHARED_ENTRIES["_rels/.rels"]);
    a.file("word/document.xml", SHARED_ENTRIES["word/document.xml"]);
    const aBuf = await a.generateAsync({ type: "arraybuffer" });

    const b = new JSZip();
    b.file("word/document.xml", SHARED_ENTRIES["word/document.xml"]);
    b.file("_rels/.rels", SHARED_ENTRIES["_rels/.rels"]);
    b.file("[Content_Types].xml", SHARED_ENTRIES["[Content_Types].xml"]);
    const bBuf = await b.generateAsync({ type: "arraybuffer" });

    const result = await compareSelectiveVsFull(aBuf, bBuf);
    expect(result.kind).toBe("match");
  });

  test("detects byte-level mismatch on a binary entry", async () => {
    const a = await makeZip({
      ...SHARED_ENTRIES,
      "word/media/image1.png": new Uint8Array([1, 2, 3, 4]),
    });
    const b = await makeZip({
      ...SHARED_ENTRIES,
      "word/media/image1.png": new Uint8Array([1, 2, 3, 5]),
    });
    const result = await compareSelectiveVsFull(a, b);
    expect(result.kind).toBe("entry-byte-diff");
    if (result.kind === "entry-byte-diff") {
      expect(result.path).toBe("word/media/image1.png");
    }
  });
});
