import { describe, expect, test } from "bun:test";

import type { Paragraph, ParagraphPropertyChange } from "../../types/content";
import { fromProseDoc } from "./fromProseDoc";
import { toProseDoc } from "./toProseDoc";

const samplePropertyChange: ParagraphPropertyChange = {
  type: "paragraphPropertyChange",
  info: {
    id: 7,
    author: "Reviewer",
    date: "2026-05-15T12:00:00Z",
  },
  previousFormatting: { alignment: "left" },
  currentFormatting: { alignment: "center" },
};

function paragraphWithPropertyChange(): Paragraph {
  return {
    type: "paragraph",
    formatting: { alignment: "center" },
    propertyChanges: [samplePropertyChange],
    content: [
      {
        type: "run",
        formatting: {},
        content: [{ type: "text", text: "body" }],
      },
    ],
  };
}

describe("paragraph propertyChanges PM round-trip", () => {
  test("toProseDoc copies propertyChanges into the paragraph node attrs", () => {
    const document = {
      package: {
        document: {
          content: [paragraphWithPropertyChange()],
          finalSectionProperties: {},
        },
      },
    };
    const pmDoc = toProseDoc(document as never);
    // The paragraph PM node now carries the entries on a private attr —
    // editor code never reads it; it exists purely so fromProseDoc can
    // restore them after an edit.
    const paragraphNode = pmDoc.firstChild!;
    expect(paragraphNode.attrs["_propertyChanges"]).toEqual([
      samplePropertyChange,
    ]);
  });

  test("fromProseDoc restores propertyChanges back onto the Folio Paragraph", () => {
    // Simulate a no-op edit: convert to PM and immediately back. The
    // entries must survive even though the editor surfaces nothing in
    // UI for them — the previous behaviour silently stripped them on
    // every edit, corrupting the `w:pPrChange` history.
    const original = paragraphWithPropertyChange();
    const document = {
      package: {
        document: {
          content: [original],
          finalSectionProperties: {},
        },
      },
    };
    const pmDoc = toProseDoc(document as never);
    const roundtripped = fromProseDoc(pmDoc).package.document.content[0] as
      | Paragraph
      | undefined;

    expect(roundtripped?.propertyChanges).toEqual([samplePropertyChange]);
  });

  test("paragraphs without propertyChanges round-trip without inventing them", () => {
    const plain: Paragraph = {
      type: "paragraph",
      formatting: {},
      content: [
        {
          type: "run",
          formatting: {},
          content: [{ type: "text", text: "plain" }],
        },
      ],
    };
    const document = {
      package: {
        document: {
          content: [plain],
          finalSectionProperties: {},
        },
      },
    };
    const pmDoc = toProseDoc(document as never);
    const roundtripped = fromProseDoc(pmDoc).package.document.content[0] as
      | Paragraph
      | undefined;
    // No phantom propertyChanges should be attached.
    expect(roundtripped?.propertyChanges).toBeUndefined();
  });
});
