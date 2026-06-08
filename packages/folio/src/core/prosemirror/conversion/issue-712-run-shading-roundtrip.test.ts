// eigenpal #722 (#712) — run-level shading (w:shd) used as a background.
//
// Folio models w:highlight as a strict OOXML named-palette union, so an
// arbitrary run-background fill (e.g. a Word/Google Docs `w:shd`, or a custom
// highlight another editor saved as shading) cannot ride on the highlight mark.
// It was parsed into `formatting.shading` but DROPPED at PM conversion, so the
// background silently vanished on reload. It now round-trips as a dedicated
// `runShading` mark and renders as a background.

import { describe, expect, test } from "bun:test";

import { toFlowBlocks } from "../../layout-bridge/toFlowBlocks";
import type { FlowBlock, TextRun } from "../../layout-engine/types";
import type {
  Document,
  Paragraph,
  Run,
  ShadingProperties,
} from "../../types/document";
import { fromProseDoc } from "./fromProseDoc";
import { toProseDoc } from "./toProseDoc";

const wrap = (formatting: Run["formatting"]): Document => ({
  package: {
    document: {
      content: [
        {
          type: "paragraph",
          content: [
            { type: "run", content: [{ type: "text", text: "x" }], formatting },
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

const firstRunFormatting = (document: Document): Run["formatting"] => {
  for (const content of firstParagraph(document).content) {
    if (content.type === "run") {
      return content.formatting;
    }
  }
  throw new Error("expected a run");
};

// The runShading mark color, as it would round-trip out to the model on save.
const roundTripShading = (
  formatting: Run["formatting"],
): ShadingProperties | undefined =>
  firstRunFormatting(
    fromProseDoc(toProseDoc(wrap(formatting)), wrap(formatting)),
  )?.shading;

// The resolved CSS background the painter receives for the run.
const renderedBackground = (
  formatting: Run["formatting"],
): string | undefined => {
  const blocks: FlowBlock[] = toFlowBlocks(toProseDoc(wrap(formatting)));
  const paragraph = blocks.find((b) => b.kind === "paragraph");
  if (paragraph?.kind !== "paragraph") {
    throw new Error("expected a paragraph flow block");
  }
  const textRun = paragraph.runs.find((r): r is TextRun => r.kind === "text");
  return textRun?.shading;
};

describe("Issue #712 — run shading round-trips and renders", () => {
  test("a solid fill renders as a background and survives the round-trip", () => {
    const shading = { fill: { rgb: "FFFF00" } };
    expect(renderedBackground({ shading })).toBe("#FFFF00");
    expect(roundTripShading({ shading })?.fill?.rgb).toBe("FFFF00");
  });

  test("the default `clear` pattern is dropped (renders solid, re-serializes to clear)", () => {
    const shading = { pattern: "clear" as const, fill: { rgb: "00B050" } };
    expect(renderedBackground({ shading })).toBe("#00B050");
    const out = roundTripShading({ shading });
    expect(out?.fill?.rgb).toBe("00B050");
    expect(out?.pattern).toBeUndefined();
  });

  test("a non-clear pattern is carried for export fidelity", () => {
    const shading = { pattern: "pct25" as const, fill: { rgb: "FFFF00" } };
    expect(roundTripShading({ shading })?.pattern).toBe("pct25");
  });

  test("a theme-color fill round-trips (themeColor preserved)", () => {
    const formatting: Run["formatting"] = {
      shading: { fill: { themeColor: "accent1" } },
    };
    expect(roundTripShading(formatting)?.fill?.themeColor).toBe("accent1");
  });

  test("highlight and shading both reach the flow run (painter resolves precedence)", () => {
    // Both fields flow through independently; the painter prefers `highlight`
    // (covered in renderParagraph-run-shading.test.ts). Here we only assert the
    // data is not lost.
    const formatting: Run["formatting"] = {
      highlight: "green",
      shading: { fill: { rgb: "FFFF00" } },
    };
    const blocks = toFlowBlocks(toProseDoc(wrap(formatting)));
    const paragraph = blocks.find((b) => b.kind === "paragraph");
    if (paragraph?.kind !== "paragraph") {
      throw new Error("expected a paragraph flow block");
    }
    const run = paragraph.runs.find((r): r is TextRun => r.kind === "text");
    expect(run?.highlight).toBeDefined();
    expect(run?.shading).toBe("#FFFF00");
  });

  test("an `auto` fill produces no shading background", () => {
    expect(renderedBackground({ shading: { fill: { auto: true } } })).toBe(
      undefined,
    );
    expect(
      roundTripShading({ shading: { fill: { auto: true } } }),
    ).toBeUndefined();
  });

  test("a fill-less shading (pattern only) produces no mark", () => {
    expect(roundTripShading({ shading: { pattern: "pct25" } })).toBeUndefined();
  });

  test("a run with no shading is unaffected", () => {
    expect(renderedBackground({ bold: true })).toBeUndefined();
    expect(roundTripShading({ bold: true })).toBeUndefined();
  });
});
