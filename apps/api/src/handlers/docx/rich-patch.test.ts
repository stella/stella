import { describe, expect, test } from "bun:test";
import { PatchType } from "docx";

import { buildPatch } from "./rich-patch";

describe("buildPatch", () => {
  test("string → PARAGRAPH patch with TextRun", () => {
    const patch = buildPatch("Hello world");

    expect(patch.type).toBe(PatchType.PARAGRAPH);
    expect(patch.children).toHaveLength(1);
  });

  test("single paragraph with runs → PARAGRAPH patch", () => {
    const patch = buildPatch({
      paragraphs: [
        {
          runs: [{ text: "Bold text", bold: true }, { text: " normal" }],
        },
      ],
    });

    // Single paragraph uses PARAGRAPH to preserve host style
    expect(patch.type).toBe(PatchType.PARAGRAPH);
    expect(patch.children).toHaveLength(2);
  });

  test("multiple paragraphs → DOCUMENT patch", () => {
    const patch = buildPatch({
      paragraphs: [
        { runs: [{ text: "First paragraph" }] },
        { runs: [{ text: "Second paragraph" }] },
      ],
    });

    expect(patch.type).toBe(PatchType.DOCUMENT);
    expect(patch.children).toHaveLength(2);
  });

  test("preserves bold and italic formatting", () => {
    const patch = buildPatch({
      paragraphs: [
        {
          runs: [
            { text: "bold", bold: true },
            { text: "italic", italic: true },
            { text: "both", bold: true, italic: true },
          ],
        },
      ],
    });

    expect(patch.type).toBe(PatchType.PARAGRAPH);
    expect(patch.children).toHaveLength(3);
  });

  test("empty string → PARAGRAPH patch", () => {
    const patch = buildPatch("");

    expect(patch.type).toBe(PatchType.PARAGRAPH);
    expect(patch.children).toHaveLength(1);
  });

  test("single paragraph single run → PARAGRAPH patch", () => {
    const patch = buildPatch({
      paragraphs: [{ runs: [{ text: "just one run" }] }],
    });

    expect(patch.type).toBe(PatchType.PARAGRAPH);
    expect(patch.children).toHaveLength(1);
  });
});
