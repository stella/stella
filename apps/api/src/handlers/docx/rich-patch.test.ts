import { describe, expect, test } from "bun:test";

import { patchXmlPart, replacePlaceholdersInText } from "./rich-patch";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

const WRAP = (body: string) =>
  `<w:document xmlns:w="${W_NS}"><w:body>${body}</w:body></w:document>`;

describe("owned OOXML placeholder patching", () => {
  test("replaces plain string placeholders in text", () => {
    const result = replacePlaceholdersInText("Hello {{name}}", {
      name: "world",
    });

    expect(result).toEqual({ text: "Hello world", changed: true });
  });

  test("leaves unmatched placeholders intact", () => {
    const result = replacePlaceholdersInText("Hello {{name}}", {});

    expect(result).toEqual({ text: "Hello {{name}}", changed: false });
  });

  test("replaces hyphenated placeholders", () => {
    const result = replacePlaceholdersInText("Hello {{party-name}}", {
      "party-name": "Alpha Ltd",
    });

    expect(result).toEqual({ text: "Hello Alpha Ltd", changed: true });
  });

  test("patches placeholders split across runs", () => {
    const xml = WRAP(
      [
        "<w:p>",
        '<w:r><w:t xml:space="preserve">Hello {{</w:t></w:r>',
        "<w:r><w:t>name}}</w:t></w:r>",
        "</w:p>",
      ].join(""),
    );

    const result = patchXmlPart(xml, { name: "world" });

    expect(result.changed).toBe(true);
    expect(result.xml).toContain("Hello ");
    expect(result.xml).toContain("world");
    expect(result.xml).not.toContain("{{");
  });

  test("keeps suffix after replacement when a placeholder spans text nodes in one run", () => {
    const xml = WRAP(
      [
        "<w:p>",
        "<w:r>",
        '<w:t xml:space="preserve">Hello {{</w:t>',
        "<w:t>name}}</w:t>",
        "<w:t>!</w:t>",
        "</w:r>",
        "</w:p>",
      ].join(""),
    );

    const result = patchXmlPart(xml, { name: "world" });

    expect(result.changed).toBe(true);
    const prefixIndex = result.xml.indexOf("Hello ");
    const replacementIndex = result.xml.indexOf("world");
    const suffixIndex = result.xml.indexOf("!");
    expect(prefixIndex).toBeGreaterThanOrEqual(0);
    expect(replacementIndex).toBeGreaterThan(prefixIndex);
    expect(suffixIndex).toBeGreaterThan(replacementIndex);
  });

  test("keeps suffix after replacement for the common two-text-node same-run split", () => {
    const xml = WRAP(
      [
        "<w:p>",
        "<w:r>",
        '<w:t xml:space="preserve">Hello {{</w:t>',
        "<w:t>name}}!</w:t>",
        "</w:r>",
        "</w:p>",
      ].join(""),
    );

    const result = patchXmlPart(xml, { name: "world" });

    expect(result.changed).toBe(true);
    expect(result.xml.indexOf("Hello ")).toBeLessThan(
      result.xml.indexOf("world"),
    );
    expect(result.xml.indexOf("world")).toBeLessThan(result.xml.indexOf("!"));
  });

  test("preserves surrounding paragraph text and source run formatting", () => {
    const xml = WRAP(
      [
        "<w:p>",
        "<w:r><w:rPr><w:b/></w:rPr>",
        '<w:t xml:space="preserve">What a {{bold}} text!</w:t>',
        "</w:r>",
        "</w:p>",
      ].join(""),
    );

    const result = patchXmlPart(xml, { bold: "sweet" });

    expect(result.xml).toContain("What a ");
    expect(result.xml).toContain("sweet");
    expect(result.xml).toContain(" text!");
    expect(result.xml.match(/<w:b(?=[\\s/>])/g)).toHaveLength(3);
  });

  test("replaces multiple placeholders in one text run", () => {
    const xml = WRAP("<w:p><w:r><w:t>A{{x}}B{{y}}C</w:t></w:r></w:p>");

    const result = patchXmlPart(xml, { x: "X", y: "Y" });

    expect(result.xml).toContain(">A<");
    expect(result.xml).toContain(">X<");
    expect(result.xml).toContain(">B<");
    expect(result.xml).toContain(">Y<");
    expect(result.xml).toContain(">C<");
  });

  test("preserves rich run formatting for standalone placeholders", () => {
    const xml = WRAP("<w:p><w:r><w:t>{{party}}</w:t></w:r></w:p>");

    const result = patchXmlPart(xml, {
      party: {
        paragraphs: [
          {
            runs: [
              { text: "Bold", bold: true },
              { text: " italic", italic: true },
            ],
          },
        ],
      },
    });

    expect(result.xml).toContain("<w:b");
    expect(result.xml).toContain("<w:i");
    expect(result.xml).toContain("Bold");
    expect(result.xml).toContain(" italic");
  });

  test("expands standalone rich values with multiple paragraphs", () => {
    const xml = WRAP("<w:p><w:r><w:t>{{clause}}</w:t></w:r></w:p>");

    const result = patchXmlPart(xml, {
      clause: {
        paragraphs: [
          { runs: [{ text: "First paragraph" }] },
          { runs: [{ text: "Second paragraph" }] },
        ],
      },
    });

    expect(result.xml.match(/<w:p/g)).toHaveLength(2);
    expect(result.xml).toContain("First paragraph");
    expect(result.xml).toContain("Second paragraph");
  });
});
