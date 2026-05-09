import { describe, expect, test } from "bun:test";

import type {
  Document,
  Paragraph,
  Style,
  StyleDefinitions,
} from "../../types/document";
import { toProseDoc } from "./toProseDoc";

function makeDocAndStyles(
  paragraph: Paragraph,
  resolvedStyleRPr: Style["rPr"],
): { doc: Document; styles: StyleDefinitions } {
  return {
    doc: { package: { document: { content: [paragraph] } } },
    styles: {
      styles: [
        {
          styleId: "RowGap",
          type: "paragraph",
          name: "RowGap",
          pPr: {},
          rPr: resolvedStyleRPr,
        },
      ],
    },
  };
}

describe("toProseDoc fontFamily merge", () => {
  test("paragraph rPr with only eastAsia preserves inherited ascii from basedOn chain", () => {
    const paragraph: Paragraph = {
      type: "paragraph",
      formatting: {
        styleId: "RowGap",
        runProperties: {
          fontFamily: { eastAsia: "Calibri" },
        },
      },
      content: [],
    };
    const { doc, styles } = makeDocAndStyles(paragraph, {
      fontFamily: { ascii: "Arial Narrow" },
    });

    const pmDoc = toProseDoc(doc, { styles });
    const defaultTextFormatting = pmDoc.firstChild?.attrs[
      "defaultTextFormatting"
    ] as { fontFamily?: { ascii?: string; eastAsia?: string } } | undefined;

    expect(defaultTextFormatting?.fontFamily?.ascii).toBe("Arial Narrow");
    expect(defaultTextFormatting?.fontFamily?.eastAsia).toBe("Calibri");
  });
});
