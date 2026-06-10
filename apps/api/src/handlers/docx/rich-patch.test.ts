import { describe, expect, test } from "bun:test";
import * as slimdom from "slimdom";

import { patchXmlPart, replacePlaceholdersInText } from "./rich-patch";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

const WRAP = (body: string) =>
  `<w:document xmlns:w="${W_NS}"><w:body>${body}</w:body></w:document>`;

/** Parse the patched XML and return the document-order `w:p` elements, asserting
 *  the part stayed well-formed (parseXmlDocument throws otherwise). */
const paragraphsOf = (xml: string): slimdom.Element[] => {
  const doc = slimdom.parseXmlDocument(xml);
  return [...doc.getElementsByTagNameNS(W_NS, "p")];
};

/** Concatenated `w:t` text of one paragraph, in document order. */
const paragraphTextOf = (paragraph: slimdom.Element): string =>
  [...paragraph.getElementsByTagNameNS(W_NS, "t")]
    .map((t) => t.textContent ?? "")
    .join("");

const isElement = (node: slimdom.Node): node is slimdom.Element =>
  node.nodeType === node.ELEMENT_NODE;

/** Serialized `w:pPr` of a paragraph, or "" when it has none. */
const pPrOf = (paragraph: slimdom.Element): string => {
  const pPr = [...paragraph.childNodes].find(
    (node) => isElement(node) && node.localName === "pPr",
  );
  return pPr ? slimdom.serializeToWellFormedString(pPr) : "";
};

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

  test("replaces placeholders padded with whitespace", () => {
    // The discovered key is unpadded, so the same key fills `{{ amount }}` —
    // discovery and replacement must agree on whitespace handling.
    const result = replacePlaceholdersInText("Rent is {{ amount }} EUR", {
      amount: "1000",
    });

    expect(result).toEqual({ text: "Rent is 1000 EUR", changed: true });
  });

  test("patches a whitespace-padded standalone placeholder", () => {
    const xml = WRAP(
      '<w:p><w:r><w:t xml:space="preserve">{{ name }}</w:t></w:r></w:p>',
    );

    const result = patchXmlPart(xml, { name: "world" });

    expect(result.changed).toBe(true);
    expect(result.xml).toContain("world");
    expect(result.xml).not.toContain("{{");
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

  test("keeps same-run non-text content after inline replacements", () => {
    const xml = WRAP(
      [
        "<w:p>",
        "<w:r>",
        '<w:t xml:space="preserve">Name: {{name}}</w:t>',
        "<w:tab/>",
        "<w:t>Date</w:t>",
        "</w:r>",
        "</w:p>",
      ].join(""),
    );

    const result = patchXmlPart(xml, { name: "Acme Ltd" });

    expect(result.changed).toBe(true);
    const prefixIndex = result.xml.indexOf("Name: ");
    const replacementIndex = result.xml.indexOf("Acme Ltd");
    const tabIndex = result.xml.indexOf("<w:tab");
    const dateIndex = result.xml.indexOf("Date");
    expect(prefixIndex).toBeGreaterThanOrEqual(0);
    expect(replacementIndex).toBeGreaterThan(prefixIndex);
    expect(tabIndex).toBeGreaterThan(replacementIndex);
    expect(dateIndex).toBeGreaterThan(tabIndex);
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
    expect(result.xml.match(/<w:b(?=[\\s/>])/gu)).toHaveLength(3);
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

    expect(result.xml.match(/<w:p/gu)).toHaveLength(2);
    expect(result.xml).toContain("First paragraph");
    expect(result.xml).toContain("Second paragraph");
  });
});

describe("standalone multi-paragraph injection inherits host pPr", () => {
  // A clause filling a slot whose host paragraph is just the marker already
  // clones the host pPr onto every inserted paragraph. Pin that contract:
  // style ref, numbering, alignment, and spacing must ride along.
  const HOST_PPR = [
    "<w:pPr>",
    '<w:pStyle w:val="BodyText"/>',
    '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr>',
    '<w:jc w:val="center"/>',
    '<w:spacing w:after="240"/>',
    "</w:pPr>",
  ].join("");

  test("each inserted paragraph carries the host pPr and host run rPr + marks", () => {
    const xml = WRAP(
      [
        "<w:p>",
        HOST_PPR,
        '<w:r><w:rPr><w:color w:val="FF0000"/></w:rPr><w:t>{{clause}}</w:t></w:r>',
        "</w:p>",
      ].join(""),
    );

    const result = patchXmlPart(xml, {
      clause: {
        paragraphs: [
          { runs: [{ text: "Alpha", bold: true }] },
          { runs: [{ text: "Beta", italic: true }] },
        ],
      },
    });

    const paragraphs = paragraphsOf(result.xml);
    expect(paragraphs).toHaveLength(2);
    expect(paragraphTextOf(paragraphs[0]!)).toBe("Alpha");
    expect(paragraphTextOf(paragraphs[1]!)).toBe("Beta");

    // Host pPr (style/numbering/alignment/spacing) cloned onto every paragraph.
    for (const paragraph of paragraphs) {
      const pPr = pPrOf(paragraph);
      expect(pPr).toContain('w:val="BodyText"');
      expect(pPr).toContain('w:numId w:val="3"');
      expect(pPr).toContain('w:val="center"');
      expect(pPr).toContain('w:after="240"');
    }

    // Host run rPr (the colour) is inherited; semantic marks layer on top.
    expect(result.xml).toContain('w:color w:val="FF0000"');
    expect(result.xml).toContain("<w:b");
    expect(result.xml).toContain("<w:i");
  });
});

describe("inline multi-paragraph injection splits the host paragraph", () => {
  const splitValue = {
    paragraphs: [
      { runs: [{ text: "Clause one" }] },
      { runs: [{ text: "Clause two" }] },
    ],
  };

  test("leading and trailing text become their own paragraphs around the clause", () => {
    const xml = WRAP(
      [
        "<w:p>",
        '<w:pPr><w:pStyle w:val="Body"/></w:pPr>',
        '<w:r><w:t xml:space="preserve">Subject to {{clause}} the parties agree.</w:t></w:r>',
        "</w:p>",
      ].join(""),
    );

    const result = patchXmlPart(xml, { clause: splitValue });
    const paragraphs = paragraphsOf(result.xml);

    expect(paragraphs.map((p) => paragraphTextOf(p))).toEqual([
      "Subject to ",
      "Clause one",
      "Clause two",
      " the parties agree.",
    ]);
    // Every produced paragraph inherits the host pPr.
    for (const paragraph of paragraphs) {
      expect(pPrOf(paragraph)).toContain('w:val="Body"');
    }
  });

  test("clause at paragraph start drops the empty leading fragment", () => {
    const xml = WRAP(
      '<w:p><w:r><w:t xml:space="preserve">{{clause}} trails.</w:t></w:r></w:p>',
    );

    const result = patchXmlPart(xml, { clause: splitValue });

    expect(paragraphsOf(result.xml).map((p) => paragraphTextOf(p))).toEqual([
      "Clause one",
      "Clause two",
      " trails.",
    ]);
  });

  test("clause at paragraph end drops the empty trailing fragment", () => {
    const xml = WRAP(
      '<w:p><w:r><w:t xml:space="preserve">Leads {{clause}}</w:t></w:r></w:p>',
    );

    const result = patchXmlPart(xml, { clause: splitValue });

    expect(paragraphsOf(result.xml).map((p) => paragraphTextOf(p))).toEqual([
      "Leads ",
      "Clause one",
      "Clause two",
    ]);
  });

  test("single-paragraph inline value stays inline (no split)", () => {
    const xml = WRAP(
      '<w:p><w:r><w:t xml:space="preserve">Subject to {{clause}} then.</w:t></w:r></w:p>',
    );

    const result = patchXmlPart(xml, {
      clause: { paragraphs: [{ runs: [{ text: "the indemnity" }] }] },
    });

    const paragraphs = paragraphsOf(result.xml);
    expect(paragraphs).toHaveLength(1);
    expect(paragraphTextOf(paragraphs[0]!)).toBe(
      "Subject to the indemnity then.",
    );
  });

  test("empty clause value leaves the host paragraph with no stray paragraph", () => {
    const xml = WRAP(
      '<w:p><w:r><w:t xml:space="preserve">Before {{clause}} after.</w:t></w:r></w:p>',
    );

    const result = patchXmlPart(xml, { clause: { paragraphs: [] } });

    const paragraphs = paragraphsOf(result.xml);
    expect(paragraphs).toHaveLength(1);
    expect(paragraphTextOf(paragraphs[0]!)).toBe("Before  after.");
  });

  test("a field marker in the same paragraph fills inline while the clause splits", () => {
    const xml = WRAP(
      [
        "<w:p>",
        '<w:r><w:t xml:space="preserve">Dear {{name}}, subject to {{clause}} signed.</w:t></w:r>',
        "</w:p>",
      ].join(""),
    );

    const result = patchXmlPart(xml, { name: "Acme", clause: splitValue });

    expect(paragraphsOf(result.xml).map((p) => paragraphTextOf(p))).toEqual([
      "Dear Acme, subject to ",
      "Clause one",
      "Clause two",
      " signed.",
    ]);
  });

  test("clause inside a table cell keeps the table well-formed", () => {
    const xml = WRAP(
      [
        "<w:tbl><w:tr><w:tc>",
        "<w:p>",
        '<w:pPr><w:pStyle w:val="Cell"/></w:pPr>',
        '<w:r><w:t xml:space="preserve">Cell {{clause}} end</w:t></w:r>',
        "</w:p>",
        "</w:tc></w:tr></w:tbl>",
      ].join(""),
    );

    const result = patchXmlPart(xml, { clause: splitValue });
    const doc = slimdom.parseXmlDocument(result.xml);

    // The split paragraphs land inside the same cell; the table is intact.
    const cells = [...doc.getElementsByTagNameNS(W_NS, "tc")];
    expect(cells).toHaveLength(1);
    const cellParagraphs = [...cells[0]!.getElementsByTagNameNS(W_NS, "p")];
    expect(cellParagraphs.map((p) => paragraphTextOf(p))).toEqual([
      "Cell ",
      "Clause one",
      "Clause two",
      " end",
    ]);
    for (const paragraph of cellParagraphs) {
      expect(pPrOf(paragraph)).toContain('w:val="Cell"');
    }
  });
});
