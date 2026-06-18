import { describe, expect, test } from "bun:test";

import { schema } from "../../schema";

describe("FootnoteRefExtension parseDOM", () => {
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
