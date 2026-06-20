// eigenpal/docx-editor#833 — a run's character-style reference (`w:rStyle`)
// must survive the PM save round-trip. The parser reads `<w:rStyle>` into
// `run.formatting.styleId` and the serializer re-emits it, but PM conversion
// baked the style's formatting into direct marks and dropped the named
// reference, so an edited run lost its Strong/Emphasis/code character-style
// link on save. A dedicated inert `runStyle` mark carries it through.

import { describe, expect, test } from "bun:test";
import type { Node as PMNode } from "prosemirror-model";

import type {
  Document,
  Paragraph,
  StyleDefinitions,
} from "../../types/document";
import { schema } from "../schema";
import { fromProseDoc, proseDocToBlocks } from "./fromProseDoc";
import { toProseDoc } from "./toProseDoc";

const doc = (): Document => ({
  package: {
    document: {
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "run",
              content: [{ type: "text", text: "strong" }],
              formatting: { styleId: "Strong" },
            },
            {
              type: "run",
              content: [{ type: "text", text: "emph" }],
              formatting: { styleId: "Emphasis" },
            },
            {
              type: "run",
              content: [{ type: "text", text: "plain" }],
              formatting: {},
            },
          ],
        },
      ],
    },
  },
});

const firstParagraph = (document: Document): Paragraph => {
  const block = document.package.document.content.at(0);
  if (block?.type !== "paragraph") {
    throw new Error("expected first block to be a paragraph");
  }
  return block;
};

const runStyleIdByText = (
  document: Document,
): Map<string, string | undefined> => {
  const map = new Map<string, string | undefined>();
  for (const content of firstParagraph(document).content) {
    if (content.type !== "run") {
      continue;
    }
    const text = content.content
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("");
    map.set(text, content.formatting?.styleId);
  }
  return map;
};

describe("run w:rStyle survives the PM round-trip (#833)", () => {
  test("styleId is preserved on the rebuilt runs", () => {
    const source = doc();
    const rebuilt = fromProseDoc(toProseDoc(source), source);
    const styleIds = runStyleIdByText(rebuilt);

    expect(styleIds.get("strong")).toBe("Strong");
    expect(styleIds.get("emph")).toBe("Emphasis");
    expect(styleIds.get("plain")).toBeUndefined();
  });
});

// The named link must not silently re-apply a character style over an edit:
// once the run's direct formatting no longer matches the style, the styleId is
// dropped on save so the edit wins (eigenpal/docx-editor#833).
const characterStyles: StyleDefinitions = {
  styles: [
    {
      styleId: "Strong",
      type: "character",
      name: "Strong",
      rPr: { bold: true },
    },
    {
      styleId: "Underlined",
      type: "character",
      name: "Underlined",
      rPr: { underline: { style: "single" } },
    },
    {
      styleId: "AutoColor",
      type: "character",
      name: "AutoColor",
      // An auto colour produces no textColor mark in toProseDoc, so its absence
      // on a run is not a divergence.
      rPr: { color: { auto: true } },
    },
    {
      styleId: "ThemeColor",
      type: "character",
      name: "Theme Color",
      rPr: { color: { themeColor: "accent1" } },
    },
    {
      styleId: "Highlighted",
      type: "character",
      name: "Highlighted",
      // A non-toggle, non-colour/size/font property the old hand-list missed.
      rPr: { highlight: "yellow" },
    },
    {
      styleId: "CjkFont",
      type: "character",
      name: "CjkFont",
      // Contributes only the East Asian slot of the compound fontFamily mark.
      rPr: { fontFamily: { eastAsia: "SimSun" } },
    },
    {
      styleId: "BoldOff",
      type: "character",
      name: "Bold Off",
      rPr: { bold: false },
    },
    {
      styleId: "NoUnderline",
      type: "character",
      name: "No Underline",
      rPr: { underline: { style: "none" } },
    },
  ],
};

const styleAwareBase: Document = {
  package: {
    styles: characterStyles,
    document: { content: [] },
  },
};

// A document carrying its own styles and a Strong-styled run, round-tripped
// through toProseDoc/fromProseDoc with no edit.
const strongStyledDocument = (): Document => ({
  package: {
    styles: characterStyles,
    document: {
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "run",
              content: [{ type: "text", text: "strong" }],
              formatting: { styleId: "Strong" },
            },
          ],
        },
      ],
    },
  },
});

function pmDocWithStyledRun(
  markSpecs: { name: string; attrs?: Record<string, unknown> }[],
): PMNode {
  const marks = markSpecs.map(({ name, attrs }) => {
    const mark = schema.marks[name]?.create(attrs);
    if (!mark) {
      throw new Error(`Unknown mark: ${name}`);
    }
    return mark;
  });
  return schema.node("doc", null, [
    schema.node("paragraph", null, [schema.text("styled", marks)]),
  ]);
}

const firstRunStyleId = (document: Document): string | undefined => {
  for (const content of firstParagraph(document).content) {
    if (content.type === "run") {
      return content.formatting?.styleId;
    }
  }
  return undefined;
};

const firstRunFormatting = (document: Document) => {
  for (const content of firstParagraph(document).content) {
    if (content.type === "run") {
      return content.formatting;
    }
  }
  return undefined;
};

describe("run w:rStyle reconciliation on save (#833)", () => {
  test("keeps the styleId when the run still matches its character style", () => {
    const pm = pmDocWithStyledRun([
      { name: "runStyle", attrs: { styleId: "Strong" } },
      { name: "bold" },
    ]);
    expect(firstRunStyleId(fromProseDoc(pm, styleAwareBase))).toBe("Strong");
  });

  test("drops the styleId when the run was edited away from its style", () => {
    // The user toggled off the bold that `Strong` contributes; the link must
    // not survive and re-bold the run in Word.
    const pm = pmDocWithStyledRun([
      { name: "runStyle", attrs: { styleId: "Strong" } },
    ]);
    expect(firstRunStyleId(fromProseDoc(pm, styleAwareBase))).toBeUndefined();
  });

  test("drops the styleId when a non-toggle style property is removed", () => {
    // `Underlined` contributes underline; a run carrying only the link (no
    // underline) has had it removed, so the link must not survive.
    const pm = pmDocWithStyledRun([
      { name: "runStyle", attrs: { styleId: "Underlined" } },
    ]);
    expect(firstRunStyleId(fromProseDoc(pm, styleAwareBase))).toBeUndefined();
  });

  test("keeps the styleId on an unedited round-trip (styles are expanded by default)", () => {
    // A no-op open/save of a document with its own styles must not strip the
    // character-style link. `toProseDoc` flattens the style onto direct marks
    // (defaulting to the document's styles), so the run still matches the style
    // and the reconciliation keeps the link (eigenpal/docx-editor#833).
    const source = strongStyledDocument();
    const rebuilt = fromProseDoc(toProseDoc(source), source);
    expect(firstRunStyleId(rebuilt)).toBe("Strong");
  });

  test("drops the styleId when any style-contributed property is removed (not just the hand-listed ones)", () => {
    // `Highlighted` contributes a highlight; a run carrying only the link has
    // had it removed. The mark-level check covers every property toProseDoc
    // emits, so this diverges even though highlight is not a toggle/colour/font.
    const pm = pmDocWithStyledRun([
      { name: "runStyle", attrs: { styleId: "Highlighted" } },
    ]);
    expect(firstRunStyleId(fromProseDoc(pm, styleAwareBase))).toBeUndefined();
  });

  test("drops the styleId when a compound mark loses a style-set sub-property", () => {
    // `CjkFont` contributes `fontFamily.eastAsia`; the run overrode ascii/hAnsi
    // but dropped eastAsia. The mark type is still present, but the East Asian
    // font the style set is gone, so the link must not survive and reapply it.
    const pm = pmDocWithStyledRun([
      { name: "runStyle", attrs: { styleId: "CjkFont" } },
      { name: "fontFamily", attrs: { ascii: "Arial", hAnsi: "Arial" } },
    ]);
    expect(firstRunStyleId(fromProseDoc(pm, styleAwareBase))).toBeUndefined();
  });

  test("keeps the styleId when the style's only colour is auto", () => {
    // `AutoColor` contributes an auto colour, which produces no textColor mark;
    // the run legitimately has none, so this must not read as a divergence.
    const pm = pmDocWithStyledRun([
      { name: "runStyle", attrs: { styleId: "AutoColor" } },
    ]);
    expect(firstRunStyleId(fromProseDoc(pm, styleAwareBase))).toBe("AutoColor");
  });

  test("keeps the styleId when direct RGB color overrides a style theme color", () => {
    const pm = pmDocWithStyledRun([
      { name: "runStyle", attrs: { styleId: "ThemeColor" } },
      { name: "textColor", attrs: { rgb: "FF0000" } },
    ]);

    const formatting = firstRunFormatting(fromProseDoc(pm, styleAwareBase));

    expect(formatting?.styleId).toBe("ThemeColor");
    expect(formatting?.color?.rgb).toBe("FF0000");
  });

  test("keeps the styleId when direct bold overrides a style's bold-off value", () => {
    const pm = pmDocWithStyledRun([
      { name: "runStyle", attrs: { styleId: "BoldOff" } },
      { name: "bold" },
    ]);

    const formatting = firstRunFormatting(fromProseDoc(pm, styleAwareBase));

    expect(formatting?.styleId).toBe("BoldOff");
    expect(formatting?.bold).toBe(true);
  });

  test("keeps the styleId when direct underline overrides a style's underline-none value", () => {
    const pm = pmDocWithStyledRun([
      { name: "runStyle", attrs: { styleId: "NoUnderline" } },
      { name: "underline", attrs: { style: "single" } },
    ]);

    const formatting = firstRunFormatting(fromProseDoc(pm, styleAwareBase));

    expect(formatting?.styleId).toBe("NoUnderline");
    expect(formatting?.underline?.style).toBe("single");
  });

  test("keeps the styleId on a field result styled only by a character style", () => {
    // A PAGE field whose result run carries only a `w:rStyle` must keep that
    // link across a no-op round-trip: toProseDoc flattens the style onto the
    // field's marks, so the reconciliation does not see it as diverging.
    const source: Document = {
      package: {
        styles: characterStyles,
        document: {
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "simpleField",
                  instruction: " PAGE ",
                  fieldType: "PAGE",
                  content: [
                    {
                      type: "run",
                      content: [{ type: "text", text: "1" }],
                      formatting: { styleId: "Strong" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    };

    const pm = toProseDoc(source);
    let fieldHasBold = false;
    let fieldHasRunStyle = false;
    pm.descendants((node) => {
      if (node.type.name !== "field") {
        return;
      }
      fieldHasBold = node.marks.some((m) => m.type.name === "bold");
      fieldHasRunStyle = node.marks.some((m) => m.type.name === "runStyle");
    });
    expect(fieldHasBold).toBe(true);
    expect(fieldHasRunStyle).toBe(true);

    const body = fromProseDoc(pm, source).package.document;
    const field = firstParagraph({
      package: { document: body },
    } as Document).content.find((c) => c.type === "simpleField");
    const fieldRun = field?.content.find((c) => c.type === "run");
    expect(fieldRun?.formatting?.styleId).toBe("Strong");
  });

  test("does not apply field-code formatting to a present, unformatted result run (#909)", () => {
    // The result run exists but carries no direct formatting (it inherits
    // paragraph defaults); the field-code fallback must NOT colour it.
    const source: Document = {
      package: {
        document: {
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "complexField",
                  instruction: " PAGE ",
                  fieldType: "PAGE",
                  fieldCode: [],
                  fieldResult: [
                    { type: "run", content: [{ type: "text", text: "1" }] },
                  ],
                  formatting: { color: { rgb: "FF0000" } },
                },
              ],
            },
          ],
        },
      },
    };

    let fieldHasColor = false;
    toProseDoc(source).descendants((node) => {
      if (node.type.name === "field") {
        fieldHasColor = node.marks.some((m) => m.type.name === "textColor");
      }
    });
    expect(fieldHasColor).toBe(false);
  });

  test("proseDocToBlocks reconciles run styles for the header/footer save path", () => {
    // Header/footer saves extract blocks directly. With the document styles it
    // must drop a styleId edited away from its style; without them it leaves the
    // link untouched (no reconciliation context).
    const blockRunStyleId = (blocks: ReturnType<typeof proseDocToBlocks>) => {
      const para = blocks.find((b) => b.type === "paragraph");
      if (para?.type !== "paragraph") {
        return undefined;
      }
      const run = para.content.find((c) => c.type === "run");
      return run?.type === "run" ? run.formatting?.styleId : undefined;
    };

    // Run carries the Strong link but not the bold it contributes (edited away).
    const pm = pmDocWithStyledRun([
      { name: "runStyle", attrs: { styleId: "Strong" } },
    ]);
    expect(blockRunStyleId(proseDocToBlocks(pm))).toBe("Strong");
    expect(
      blockRunStyleId(proseDocToBlocks(pm, characterStyles)),
    ).toBeUndefined();
  });

  test("fromProseDoc does not reconcile preserved base document comments", () => {
    const baseDocument: Document = {
      package: {
        styles: characterStyles,
        document: {
          content: [],
          comments: [
            {
              id: 1,
              author: "Reviewer",
              content: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "run",
                      content: [{ type: "text", text: "comment" }],
                      formatting: { styleId: "Strong" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    };
    const pm = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("body")]),
    ]);

    const rebuilt = fromProseDoc(pm, baseDocument);
    const rebuiltCommentRun = rebuilt.package.document.comments
      ?.at(0)
      ?.content.at(0)
      ?.content.at(0);
    const baseCommentRun = baseDocument.package.document.comments
      ?.at(0)
      ?.content.at(0)
      ?.content.at(0);

    expect(rebuiltCommentRun?.type).toBe("run");
    if (rebuiltCommentRun?.type !== "run" || baseCommentRun?.type !== "run") {
      return;
    }
    expect(rebuiltCommentRun.formatting?.styleId).toBe("Strong");
    expect(baseCommentRun.formatting?.styleId).toBe("Strong");
  });
});
