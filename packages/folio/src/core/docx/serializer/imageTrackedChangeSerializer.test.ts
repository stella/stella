/**
 * Serializer guard: a deleted drawing/shape run keeps its content verbatim
 * inside a `<w:del>` wrapper. The `<w:t>` → `<w:delText>` rewrite must skip
 * drawing runs because:
 *
 * - a picture has no `<w:t>` anyway, and
 * - a shape's nested textbox text (`<w:txbxContent><w:t>`) belongs to a
 *   nested textbox document, NOT to the run's own deleted text. Rewriting
 *   it to `<w:delText>` produces invalid OOXML markup.
 *
 * The fix is conservative — it only suppresses the rewrite for runs that
 * carry a drawing or shape, so the normal text-deletion path is unchanged.
 * Port of eigenpal docx-editor #641 reviewer-fix commit.
 */

import { describe, expect, test } from "bun:test";

import type { Deletion, Insertion, Paragraph } from "../../types/document";
import { serializeParagraph } from "./paragraphSerializer";

const PNG_DATA_URL = "data:image/png;base64,AA==";

function deletedDrawingParagraph(): Paragraph {
  const deletion: Deletion = {
    type: "deletion",
    info: {
      id: 1,
      author: "Reviewer",
      date: "2026-05-30T00:00:00Z",
    },
    content: [
      {
        type: "run",
        content: [
          {
            type: "drawing",
            image: {
              type: "image",
              rId: "rIdImg1",
              src: PNG_DATA_URL,
              size: { width: 914_400, height: 457_200 },
              wrap: { type: "inline" },
            },
          },
        ],
      },
    ],
  };
  return { type: "paragraph", content: [deletion] };
}

function deletedTextParagraph(): Paragraph {
  const deletion: Deletion = {
    type: "deletion",
    info: {
      id: 2,
      author: "Reviewer",
      date: "2026-05-30T00:00:00Z",
    },
    content: [
      {
        type: "run",
        content: [{ type: "text", text: "gone" }],
      },
    ],
  };
  return { type: "paragraph", content: [deletion] };
}

function deletedMixedTextAndDrawingParagraph(): Paragraph {
  const deletion: Deletion = {
    type: "deletion",
    info: {
      id: 4,
      author: "Reviewer",
      date: "2026-05-30T00:00:00Z",
    },
    content: [
      {
        type: "run",
        content: [
          { type: "text", text: "gone" },
          {
            type: "drawing",
            image: {
              type: "image",
              rId: "rIdImg3",
              src: PNG_DATA_URL,
              size: { width: 914_400, height: 457_200 },
              wrap: { type: "inline" },
            },
          },
        ],
      },
    ],
  };
  return { type: "paragraph", content: [deletion] };
}

function insertedDrawingParagraph(): Paragraph {
  const insertion: Insertion = {
    type: "insertion",
    info: {
      id: 3,
      author: "Reviewer",
      date: "2026-05-30T00:00:00Z",
    },
    content: [
      {
        type: "run",
        content: [
          {
            type: "drawing",
            image: {
              type: "image",
              rId: "rIdImg2",
              src: PNG_DATA_URL,
              size: { width: 914_400, height: 457_200 },
              wrap: { type: "inline" },
            },
          },
        ],
      },
    ],
  };
  return { type: "paragraph", content: [insertion] };
}

describe("serializeParagraph — tracked image (eigenpal #641)", () => {
  test("deleted drawing run does NOT rewrite <w:t> to <w:delText>", () => {
    const xml = serializeParagraph(deletedDrawingParagraph());
    expect(xml).toContain("<w:del ");
    expect(xml).toContain("<w:drawing>");
    // The drawing-run gate: the rewrite must not fire for a drawing-bearing
    // run. A nested textbox would surface `<w:t>` inside `<w:txbxContent>`,
    // which must remain `<w:t>`, not become `<w:delText>`.
    expect(xml).not.toContain("<w:delText");
  });

  test("deleted text run STILL rewrites <w:t> to <w:delText> (gate is conservative)", () => {
    const xml = serializeParagraph(deletedTextParagraph());
    expect(xml).toContain("<w:del ");
    expect(xml).toContain("<w:delText");
    expect(xml).toContain("gone</w:delText>");
  });

  test("deleted mixed text and drawing run rewrites only the top-level text", () => {
    const xml = serializeParagraph(deletedMixedTextAndDrawingParagraph());
    expect(xml).toContain("<w:del ");
    expect(xml).toContain("<w:delText");
    expect(xml).toContain("gone</w:delText>");
    expect(xml).toContain("<w:drawing>");
    expect(xml).not.toContain("gone</w:t>");
  });

  test("inserted drawing run serializes inside <w:ins> with a <w:drawing>", () => {
    const xml = serializeParagraph(insertedDrawingParagraph());
    expect(xml).toContain("<w:ins ");
    expect(xml).toContain('w:author="Reviewer"');
    expect(xml).toContain("<w:drawing>");
  });
});
