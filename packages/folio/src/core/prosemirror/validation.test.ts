import { describe, expect, test } from "bun:test";

import { schema } from "./schema";
import {
  assertValidProseMirrorDocument,
  validateProseMirrorDocument,
} from "./validation";

describe("ProseMirror document validation", () => {
  test("reports attr issues with document paths", () => {
    const highlight = schema.mark("highlight", { color: "customYellow" });
    const doc = schema.node("doc", null, [
      schema.node("paragraph", { paraId: 12 }, [
        schema.text("bad", [highlight]),
        schema.node("field", {
          fieldType: "NOT_A_FIELD",
          instruction: " PAGE ",
          displayText: "1",
          fieldKind: "simple",
        }),
      ]),
    ]);

    const result = validateProseMirrorDocument(doc);

    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        "doc.content[0].paragraph.attrs.paraId",
        "doc.content[0].content[0].marks[0].highlight.attrs.color",
        "doc.content[0].content[1].field.attrs.fieldType",
      ]),
    );
  });

  test("throws a formatted validation error", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", { lineSpacing: "240" }, [
        schema.text("invalid"),
      ]),
    ]);

    expect(() =>
      assertValidProseMirrorDocument(doc, "Cannot use invalid PM document"),
    ).toThrow(
      "ProseMirror document error at doc.content[0].paragraph.attrs.lineSpacing",
    );
  });
});
