import { describe, expect, test } from "bun:test";

import { toProseDoc } from "../core/prosemirror";
import { schema } from "../core/prosemirror/schema";
import { createEmptyDocument } from "../core/utils/createDocument";
import {
  collectInitialLayoutFontFaces,
  collectInitialLayoutFontFamilies,
} from "./PagedEditor";

describe("initial layout font loading", () => {
  test("loads only document-driven font families plus metric-compatible fallbacks", () => {
    const document = createEmptyDocument({ initialText: "Hello" });
    const pmDoc = toProseDoc(document);

    const families = collectInitialLayoutFontFamilies(document, pmDoc);

    expect(families).toContain("Calibri");
    expect(families).toContain("Carlito");
    expect(families).toContain("Arial");
    expect(families).toContain("Arimo");
    expect(families).not.toContain("Cambria");
    expect(families).not.toContain("Times New Roman");
    expect(families).not.toContain("Courier New");
  });

  test("does not load unused italic font faces for plain document text", () => {
    const document = createEmptyDocument({ initialText: "Hello" });
    const pmDoc = toProseDoc(document);

    const faces = collectInitialLayoutFontFaces(document, pmDoc).map(
      fontFaceKey,
    );

    expect(faces).toContain("Arial|normal|400");
    expect(faces).toContain("Arimo|normal|400");
    expect(faces).not.toContain("Arial|italic|400");
    expect(faces).not.toContain("Arimo|italic|700");
  });

  test("loads only used bold and italic font faces", () => {
    const bold = schema.marks["bold"]?.create();
    const fontFamily = schema.marks["fontFamily"]?.create({
      ascii: "Cambria",
      hAnsi: "Cambria",
    });
    if (!bold || !fontFamily) {
      throw new Error("Expected bold and fontFamily marks in schema");
    }

    const pmDoc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("Bold Cambria", [bold, fontFamily]),
      ]),
    ]);

    const faces = collectInitialLayoutFontFaces(null, pmDoc).map(fontFaceKey);

    expect(faces).toContain("Cambria|normal|700");
    expect(faces).toContain("Caladea|normal|700");
    expect(faces).not.toContain("Cambria|italic|400");
    expect(faces).not.toContain("Cambria|italic|700");
  });

  test("combines inherited text formatting with explicit marks", () => {
    const bold = schema.marks["bold"]?.create();
    if (!bold) {
      throw new Error("Expected bold mark in schema");
    }

    const pmDoc = schema.node("doc", null, [
      schema.node(
        "paragraph",
        {
          defaultTextFormatting: {
            fontFamily: { ascii: "Cambria", hAnsi: "Cambria" },
            italic: true,
          },
        },
        [schema.text("Bold inherited italic", [bold])],
      ),
    ]);

    const faces = collectInitialLayoutFontFaces(null, pmDoc).map(fontFaceKey);

    expect(faces).toContain("Cambria|italic|700");
    expect(faces).toContain("Caladea|italic|700");
  });
});

function fontFaceKey(face: {
  family: string;
  style: string;
  weight: number;
}): string {
  return `${face.family}|${face.style}|${face.weight}`;
}
