/**
 * Character style (w:rStyle) round-trip through ProseMirror.
 *
 * A run's character style reference must survive load → edit → save: the
 * style's formatting is resolved through the style chain for rendering
 * (flattened into regular marks), while a `characterStyle` mark carries the
 * reference plus a snapshot of the style's own properties so the serializer
 * re-emits `w:rStyle` instead of baking the style formatting into the run.
 */

import { describe, expect, test } from "bun:test";
import { EditorState, TextSelection } from "prosemirror-state";

import type {
  Document,
  Paragraph,
  Run,
  StyleDefinitions,
} from "../../types/document";
import { schema } from "../schema";
import { fromProseDoc } from "./fromProseDoc";
import { toProseDoc } from "./toProseDoc";

const runText = (text: string, formatting?: Run["formatting"]): Run => {
  const run: Run = {
    type: "run",
    content: [{ type: "text", text }],
  };
  if (formatting) {
    run.formatting = formatting;
  }
  return run;
};

const wrapParagraph = (paragraph: Paragraph): Document => ({
  package: {
    document: {
      content: [paragraph],
    },
  },
});

const wrap = (...runs: Run[]): Document =>
  wrapParagraph({ type: "paragraph", content: runs });

const styles: StyleDefinitions = {
  styles: [
    {
      styleId: "DefinedTerm",
      type: "character",
      name: "Defined Term",
      rPr: { italic: true, color: { rgb: "336699" } },
    },
    {
      styleId: "AccentChar",
      type: "character",
      name: "Accent Character",
      rPr: { color: { rgb: "00AA00" } },
    },
    {
      styleId: "StrongHeading",
      type: "paragraph",
      name: "Strong Heading",
      rPr: { bold: true, color: { rgb: "0000FF" } },
    },
  ],
};

const firstParagraph = (document: Document): Paragraph => {
  const block = document.package.document.content.at(0);
  if (block?.type !== "paragraph") {
    throw new Error("Expected first block to be a paragraph");
  }
  return block;
};

const paragraphRuns = (paragraph: Paragraph): Run[] =>
  paragraph.content.filter((content): content is Run => content.type === "run");

const findRun = (paragraph: Paragraph, text: string): Run => {
  for (const run of paragraphRuns(paragraph)) {
    const concat = run.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    if (concat === text) {
      return run;
    }
  }
  throw new Error(`Expected run with text ${text}`);
};

const markNames = (document: Document, text: string): string[] => {
  const pmDoc = toProseDoc(document, { styles });
  let names: string[] | undefined;
  pmDoc.descendants((node) => {
    if (node.isText && node.text === text) {
      names = node.marks.map((mark) => mark.type.name);
    }
    return true;
  });
  if (!names) {
    throw new Error(`Expected PM text node ${text}`);
  }
  return names;
};

describe("characterStyle mark schema registration", () => {
  test("schema includes the characterStyle mark", () => {
    expect(schema.marks["characterStyle"]).toBeDefined();
  });
});

describe("character style rendering resolution", () => {
  test("styled run renders the style's formatting via regular marks", () => {
    const input = wrap(runText("Term", { styleId: "DefinedTerm" }));
    const names = markNames(input, "Term");
    expect(names).toContain("italic");
    expect(names).toContain("textColor");
    expect(names).toContain("characterStyle");
  });

  test("direct formatting wins over the character style", () => {
    const input = wrap(
      runText("Term", { styleId: "DefinedTerm", color: { rgb: "FF0000" } }),
    );
    const pmDoc = toProseDoc(input, { styles });
    let rgb: unknown;
    pmDoc.descendants((node) => {
      if (node.isText && node.text === "Term") {
        const mark = node.marks.find((m) => m.type.name === "textColor");
        rgb = mark?.attrs["rgb"];
      }
      return true;
    });
    expect(rgb).toBe("FF0000");
  });

  test("character style wins over the paragraph style", () => {
    const input = wrapParagraph({
      type: "paragraph",
      formatting: { styleId: "StrongHeading" },
      content: [runText("Term", { styleId: "AccentChar" })],
    });
    const pmDoc = toProseDoc(input, { styles });
    let rgb: unknown;
    let bold = false;
    pmDoc.descendants((node) => {
      if (node.isText && node.text === "Term") {
        const mark = node.marks.find((m) => m.type.name === "textColor");
        rgb = mark?.attrs["rgb"];
        bold = node.marks.some((m) => m.type.name === "bold");
      }
      return true;
    });
    // Color comes from the character style; bold still cascades down from
    // the paragraph style because the character style does not redefine it.
    expect(rgb).toBe("00AA00");
    expect(bold).toBe(true);
  });
});

describe("character style round-trip", () => {
  test("a pure style reference round-trips without baked direct formatting", () => {
    const input = wrap(runText("Term", { styleId: "DefinedTerm" }));
    const pmDoc = toProseDoc(input, { styles });
    const out = fromProseDoc(pmDoc, input);
    const run = findRun(firstParagraph(out), "Term");
    expect(run.formatting).toEqual({ styleId: "DefinedTerm" });
  });

  test("direct overrides survive next to the style reference", () => {
    const input = wrap(
      runText("Term", { styleId: "DefinedTerm", color: { rgb: "FF0000" } }),
    );
    const pmDoc = toProseDoc(input, { styles });
    const out = fromProseDoc(pmDoc, input);
    const run = findRun(firstParagraph(out), "Term");
    expect(run.formatting?.styleId).toBe("DefinedTerm");
    expect(run.formatting?.color).toEqual({ rgb: "FF0000" });
    // Italic came purely from the style — it must not be baked in.
    expect(run.formatting?.italic).toBeUndefined();
  });

  test("round-trip is stable across a second load/save cycle", () => {
    const input = wrap(runText("Term", { styleId: "DefinedTerm" }));
    const once = fromProseDoc(toProseDoc(input, { styles }), input);
    const twice = fromProseDoc(toProseDoc(once, { styles }), once);
    expect(findRun(firstParagraph(twice), "Term").formatting).toEqual({
      styleId: "DefinedTerm",
    });
  });

  test("hyperlink child runs keep their character style", () => {
    const input: Document = wrapParagraph({
      type: "paragraph",
      content: [
        {
          type: "hyperlink",
          href: "https://example.com",
          children: [runText("link", { styleId: "DefinedTerm" })],
        },
      ],
    });
    const pmDoc = toProseDoc(input, { styles });
    const out = fromProseDoc(pmDoc, input);
    const hyperlink = firstParagraph(out).content.find(
      (content) => content.type === "hyperlink",
    );
    if (hyperlink?.type !== "hyperlink") {
      throw new Error("Expected hyperlink");
    }
    const child = hyperlink.children.at(0);
    expect(child?.formatting?.styleId).toBe("DefinedTerm");
  });
});

describe("unknown and malformed style references", () => {
  test("unknown styleId round-trips verbatim with direct formatting intact", () => {
    const input = wrap(runText("Term", { styleId: "NoSuchStyle", bold: true }));
    const pmDoc = toProseDoc(input, { styles });
    const out = fromProseDoc(pmDoc, input);
    const run = findRun(firstParagraph(out), "Term");
    expect(run.formatting?.styleId).toBe("NoSuchStyle");
    expect(run.formatting?.bold).toBe(true);
  });

  test("unknown styleId resolves no formatting and does not crash", () => {
    const input = wrap(runText("Term", { styleId: "NoSuchStyle" }));
    const names = markNames(input, "Term");
    expect(names).toEqual(["characterStyle"]);
  });

  test("styleId round-trips without any style definitions at all", () => {
    const input = wrap(runText("Term", { styleId: "DefinedTerm" }));
    const pmDoc = toProseDoc(input);
    const out = fromProseDoc(pmDoc, input);
    expect(findRun(firstParagraph(out), "Term").formatting?.styleId).toBe(
      "DefinedTerm",
    );
  });

  test("basedOn cycle in style definitions terminates and round-trips", () => {
    const cyclicStyles: StyleDefinitions = {
      styles: [
        {
          styleId: "CycleA",
          type: "character",
          name: "Cycle A",
          basedOn: "CycleB",
          rPr: { bold: true },
        },
        {
          styleId: "CycleB",
          type: "character",
          name: "Cycle B",
          basedOn: "CycleA",
          rPr: { italic: true },
        },
      ],
    };
    const input = wrap(runText("Term", { styleId: "CycleA" }));
    const pmDoc = toProseDoc(input, { styles: cyclicStyles });
    const out = fromProseDoc(pmDoc, input);
    expect(findRun(firstParagraph(out), "Term").formatting?.styleId).toBe(
      "CycleA",
    );
  });
});

describe("character style under editing", () => {
  const styledState = (): EditorState => {
    const input = wrap(runText("Term", { styleId: "DefinedTerm" }));
    const pmDoc = toProseDoc(input, { styles });
    return EditorState.create({ doc: pmDoc });
  };

  test("typing in the middle of a styled run keeps the style", () => {
    const state = styledState();
    // Position 3 is between "Te" and "rm" (paragraph opens at 0, text at 1).
    const tr = state.tr.setSelection(TextSelection.create(state.doc, 3));
    tr.insertText("XY");
    const edited = state.apply(tr);
    const out = fromProseDoc(edited.doc, wrap());
    const run = findRun(firstParagraph(out), "TeXYrm");
    expect(run.formatting?.styleId).toBe("DefinedTerm");
  });

  test("splitting a styled run keeps the style on both halves", () => {
    const state = styledState();
    // Insert unmarked text in the middle: the styled run splits in two.
    const tr = state.tr.replaceWith(3, 3, schema.text("PLAIN"));
    const edited = state.apply(tr);
    const out = fromProseDoc(edited.doc, wrap());
    const runs = paragraphRuns(firstParagraph(out));
    expect(runs).toHaveLength(3);
    expect(findRun(firstParagraph(out), "Te").formatting?.styleId).toBe(
      "DefinedTerm",
    );
    expect(findRun(firstParagraph(out), "PLAIN").formatting).toBeUndefined();
    expect(findRun(firstParagraph(out), "rm").formatting?.styleId).toBe(
      "DefinedTerm",
    );
  });

  test("removing the characterStyle mark strips the reference but keeps visuals", () => {
    const state = styledState();
    const characterStyle = schema.marks["characterStyle"];
    if (!characterStyle) {
      throw new Error("Expected characterStyle mark type");
    }
    const tr = state.tr.removeMark(1, 5, characterStyle);
    const edited = state.apply(tr);
    const out = fromProseDoc(edited.doc, wrap());
    const run = findRun(firstParagraph(out), "Term");
    expect(run.formatting?.styleId).toBeUndefined();
    // The flattened rendering formatting is now genuinely direct.
    expect(run.formatting?.italic).toBe(true);
    expect(run.formatting?.color).toEqual({ rgb: "336699" });
  });
});
