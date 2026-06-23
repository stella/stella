import { describe, expect, test } from "bun:test";

import { schema } from "../../schema";

describe("FootnoteRefExtension parseDOM", () => {
  test("parses superscript footnote refs rendered as sup", () => {
    const footnoteRef = schema.marks["footnoteRef"];
    if (!footnoteRef) {
      throw new Error("expected footnoteRef mark");
    }
    const parseRules = footnoteRef.spec.parseDOM ?? [];
    const rule = parseRules.find(
      (candidate) => candidate.tag === "sup.docx-footnote-ref",
    );
    if (!rule || typeof rule.getAttrs !== "function") {
      throw new Error("expected sup footnoteRef getAttrs rule");
    }

    const attrs = rule.getAttrs({
      dataset: { id: "7", noteType: "footnote" },
    } as unknown as HTMLElement);

    expect(attrs).toEqual({
      id: "7",
      noteType: "footnote",
      vertAlign: "superscript",
    });
  });

  test("parses baseline footnote refs rendered as spans", () => {
    const footnoteRef = schema.marks["footnoteRef"];
    if (!footnoteRef) {
      throw new Error("expected footnoteRef mark");
    }
    const parseRules = footnoteRef.spec.parseDOM ?? [];
    const rule = parseRules.find(
      (candidate) => candidate.tag === "span.docx-footnote-ref",
    );
    if (!rule || typeof rule.getAttrs !== "function") {
      throw new Error("expected span footnoteRef getAttrs rule");
    }

    const attrs = rule.getAttrs({
      dataset: { id: "7", noteType: "footnote" },
    } as unknown as HTMLElement);

    expect(attrs).toEqual({
      id: "7",
      noteType: "footnote",
      vertAlign: "baseline",
    });
  });

  test("parses baseline endnote refs rendered as spans", () => {
    const footnoteRef = schema.marks["footnoteRef"];
    if (!footnoteRef) {
      throw new Error("expected footnoteRef mark");
    }
    const parseRules = footnoteRef.spec.parseDOM ?? [];
    const rule = parseRules.find(
      (candidate) => candidate.tag === "span.docx-endnote-ref",
    );
    if (!rule || typeof rule.getAttrs !== "function") {
      throw new Error("expected span endnoteRef getAttrs rule");
    }

    const attrs = rule.getAttrs({
      dataset: { id: "9", noteType: "endnote" },
    } as unknown as HTMLElement);

    expect(attrs).toEqual({
      id: "9",
      noteType: "endnote",
      vertAlign: "baseline",
    });
  });
});

describe("FootnoteRefExtension toDOM", () => {
  test("renders unset footnote refs as baseline spans", () => {
    const footnoteRef = schema.marks["footnoteRef"];
    if (!footnoteRef?.spec.toDOM) {
      throw new Error("expected footnoteRef toDOM");
    }

    const dom = footnoteRef.spec.toDOM(
      footnoteRef.create({ id: "7", noteType: "footnote" }),
      false,
    );

    expect(dom).toEqual([
      "span",
      {
        class: "docx-footnote-ref docx-note-ref-baseline",
        "data-id": "7",
        "data-note-type": "footnote",
      },
      0,
    ]);
  });

  test("renders explicit superscript footnote refs as sup", () => {
    const footnoteRef = schema.marks["footnoteRef"];
    if (!footnoteRef?.spec.toDOM) {
      throw new Error("expected footnoteRef toDOM");
    }

    const dom = footnoteRef.spec.toDOM(
      footnoteRef.create({
        id: "7",
        noteType: "footnote",
        vertAlign: "superscript",
      }),
      false,
    );

    expect(dom).toEqual([
      "sup",
      {
        class: "docx-footnote-ref docx-note-ref-superscript",
        "data-id": "7",
        "data-note-type": "footnote",
      },
      0,
    ]);
  });
});
