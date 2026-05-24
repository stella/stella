import { describe, expect, test } from "bun:test";
import { EditorState } from "prosemirror-state";

import { schema } from "../schema";
import { fromProseDoc } from "./fromProseDoc";
import { toProseDoc } from "./toProseDoc";

describe("fromProseDoc", () => {
  test("rejects malformed paragraph attrs at the conversion boundary", () => {
    const pmDoc = schema.node("doc", null, [
      schema.node("paragraph", { paraId: 12 }, [schema.text("invalid")]),
    ]);

    expect(() => fromProseDoc(pmDoc)).toThrow("paragraph.attrs.paraId");
  });

  test("rejects malformed hyperlink attrs at the conversion boundary", () => {
    const hyperlinkMark = schema.mark("hyperlink", { href: 123 });
    const pmDoc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("linked", [hyperlinkMark])]),
    ]);

    expect(() => fromProseDoc(pmDoc)).toThrow("hyperlink.attrs.href");
  });

  test("accepts table header cell attrs at the table-cell boundary", () => {
    const pmDoc = schema.node("doc", null, [
      schema.node("table", null, [
        schema.node("tableRow", null, [
          schema.node("tableHeader", null, [
            schema.node("paragraph", null, [schema.text("Header")]),
          ]),
        ]),
      ]),
    ]);

    const document = fromProseDoc(pmDoc);
    const table = document.package.document.content[0];

    expect(table?.type).toBe("table");
    if (table?.type !== "table") {
      return;
    }
    expect(table.rows[0]?.cells[0]?.content[0]?.type).toBe("paragraph");
  });

  test("preserves comment ranges added to selected text", () => {
    const commentMark = schema.mark("comment", { commentId: 123 });
    const pmDoc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("before "),
        schema.text("commented", [commentMark]),
        schema.text(" after"),
      ]),
    ]);

    const document = fromProseDoc(pmDoc);
    const paragraph = document.package.document.content[0];

    expect(paragraph?.type).toBe("paragraph");
    if (paragraph?.type !== "paragraph") {
      return;
    }

    expect(paragraph.content.map((content) => content.type)).toEqual([
      "run",
      "commentRangeStart",
      "run",
      "commentRangeEnd",
      "run",
    ]);

    const roundTripped = toProseDoc(document);
    const markedText = roundTripped.firstChild?.child(1);
    const comment = markedText?.marks.find(
      (mark) => mark.type.name === "comment",
    );

    expect(markedText?.text).toBe("commented");
    expect(comment?.attrs.commentId).toBe(123);
  });

  test("preserves comment ranges across multiple paragraphs", () => {
    const commentMark = schema.mark("comment", { commentId: 456 });
    const pmDoc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("first ", [commentMark]),
        schema.text("paragraph", [commentMark]),
      ]),
      schema.node("paragraph", null, [
        schema.text("second ", [commentMark]),
        schema.text("paragraph", [commentMark]),
      ]),
    ]);

    const document = fromProseDoc(pmDoc);
    const roundTripped = toProseDoc(document);

    const markedTexts: string[] = [];
    roundTripped.descendants((node) => {
      if (
        node.isText &&
        node.marks.some(
          (mark) =>
            mark.type.name === "comment" && mark.attrs.commentId === 456,
        )
      ) {
        markedTexts.push(node.text ?? "");
      }
    });

    expect(markedTexts.join("")).toBe("first paragraphsecond paragraph");
  });

  test("preserves comment ranges inside table cells", () => {
    const commentMark = schema.mark("comment", { commentId: 789 });
    const pmDoc = schema.node("doc", null, [
      schema.node("table", null, [
        schema.node("tableRow", null, [
          schema.node("tableCell", null, [
            schema.node("paragraph", null, [
              schema.text("cell one", [commentMark]),
            ]),
          ]),
          schema.node("tableCell", null, [
            schema.node("paragraph", null, [
              schema.text("cell two", [commentMark]),
            ]),
          ]),
        ]),
      ]),
    ]);

    const document = fromProseDoc(pmDoc);
    const roundTripped = toProseDoc(document);

    const markedTexts: string[] = [];
    roundTripped.descendants((node) => {
      if (
        node.isText &&
        node.marks.some(
          (mark) =>
            mark.type.name === "comment" && mark.attrs.commentId === 789,
        )
      ) {
        markedTexts.push(node.text ?? "");
      }
    });

    expect(markedTexts).toEqual(["cell one", "cell two"]);
  });

  test("preserves comment ranges on hyperlinks", () => {
    const commentMark = schema.mark("comment", { commentId: 321 });
    const hyperlinkMark = schema.mark("hyperlink", {
      href: "https://stella.law",
    });
    const pmDoc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("before "),
        schema.text("linked", [hyperlinkMark, commentMark]),
        schema.text(" after"),
      ]),
    ]);

    const document = fromProseDoc(pmDoc);
    const roundTripped = toProseDoc(document);
    const markedText = roundTripped.firstChild?.child(1);
    const comment = markedText?.marks.find(
      (mark) => mark.type.name === "comment",
    );
    const hyperlink = markedText?.marks.find(
      (mark) => mark.type.name === "hyperlink",
    );

    expect(markedText?.text).toBe("linked");
    expect(comment?.attrs.commentId).toBe(321);
    expect(hyperlink?.attrs.href).toBe("https://stella.law");
  });

  test("preserves ProseMirror addMark comments spanning block boundaries", () => {
    const commentId = 999;
    const commentMark = schema.mark("comment", { commentId });
    const initialDoc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("before")]),
      schema.node("table", null, [
        schema.node("tableRow", null, [
          schema.node("tableCell", null, [
            schema.node("paragraph", null, [schema.text("cell one")]),
          ]),
          schema.node("tableCell", null, [
            schema.node("paragraph", null, [schema.text("cell two")]),
          ]),
        ]),
      ]),
      schema.node("paragraph", null, [schema.text("after")]),
    ]);
    const state = EditorState.create({ doc: initialDoc, schema });
    const docWithMark = state.tr.addMark(
      1,
      state.doc.content.size - 1,
      commentMark,
    ).doc;

    const document = fromProseDoc(docWithMark);
    const roundTripped = toProseDoc(document);

    const markedTexts: string[] = [];
    roundTripped.descendants((node) => {
      if (
        node.isText &&
        node.marks.some(
          (mark) =>
            mark.type.name === "comment" && mark.attrs.commentId === commentId,
        )
      ) {
        markedTexts.push(node.text ?? "");
      }
    });

    expect(markedTexts).toEqual(["before", "cell one", "cell two", "after"]);
  });
});
