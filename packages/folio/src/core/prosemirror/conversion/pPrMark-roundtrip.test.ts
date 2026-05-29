import { describe, expect, test } from "bun:test";

import type { Document, Paragraph } from "../../types/document";
import { fromProseDoc } from "./fromProseDoc";
import { toProseDoc } from "./toProseDoc";

function paragraphWithMark(mark: NonNullable<Paragraph["pPrMark"]>): Document {
  return {
    package: {
      document: {
        content: [
          {
            type: "paragraph",
            pPrMark: mark,
            content: [
              { type: "run", content: [{ type: "text", text: "hello" }] },
            ],
          },
        ],
      },
    },
  };
}

describe("pPrMark — toProseDoc / fromProseDoc round-trip", () => {
  test("preserves pPrMark.kind = 'ins' through PM and back", () => {
    const doc = paragraphWithMark({
      kind: "ins",
      info: { id: 1, author: "Alice", date: "2026-05-01T10:00:00Z" },
    });

    const pmDoc = toProseDoc(doc);
    const paragraph = pmDoc.firstChild;
    expect(paragraph?.type.name).toBe("paragraph");
    expect(paragraph?.attrs["pPrMark"]).toEqual({
      kind: "ins",
      info: { id: 1, author: "Alice", date: "2026-05-01T10:00:00Z" },
    });

    const rebuilt = fromProseDoc(pmDoc, doc);
    const para = rebuilt.package.document.content.at(0);
    expect(para?.type).toBe("paragraph");
    if (para?.type !== "paragraph") {
      return;
    }
    expect(para.pPrMark).toEqual({
      kind: "ins",
      info: { id: 1, author: "Alice", date: "2026-05-01T10:00:00Z" },
    });
  });

  test("preserves pPrMark.kind = 'del' through PM and back", () => {
    const doc = paragraphWithMark({
      kind: "del",
      info: { id: 9, author: "Bob" },
    });

    const pmDoc = toProseDoc(doc);
    const rebuilt = fromProseDoc(pmDoc, doc);
    const para = rebuilt.package.document.content.at(0);
    expect(para?.type).toBe("paragraph");
    if (para?.type !== "paragraph") {
      return;
    }
    expect(para.pPrMark).toEqual({
      kind: "del",
      info: { id: 9, author: "Bob" },
    });
  });

  test("absent pPrMark stays absent through the round-trip", () => {
    const doc: Document = {
      package: {
        document: {
          content: [
            {
              type: "paragraph",
              content: [
                { type: "run", content: [{ type: "text", text: "hello" }] },
              ],
            },
          ],
        },
      },
    };

    const pmDoc = toProseDoc(doc);
    const rebuilt = fromProseDoc(pmDoc, doc);
    const para = rebuilt.package.document.content.at(0);
    expect(para?.type).toBe("paragraph");
    if (para?.type !== "paragraph") {
      return;
    }
    expect(para.pPrMark).toBeUndefined();
  });
});
