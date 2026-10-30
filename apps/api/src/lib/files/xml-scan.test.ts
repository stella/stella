import { expect, test } from "bun:test";
import fc from "fast-check";
import { SaxesParser } from "saxes";

import { assertProperty } from "@stll/property-testing";

import {
  clearXmlElements,
  firstXmlElement,
  removeXmlElements,
  replaceXmlElementContent,
  replaceXmlElements,
  xmlElementText,
  XmlScanError,
} from "./xml-scan";

type XmlOracleEvent =
  | { type: "open"; name: string; attributes: [string, string][] }
  | { type: "text"; value: string }
  | { type: "close"; name: string };

const parseXmlWithOracle = (xml: string): XmlOracleEvent[] => {
  const events: XmlOracleEvent[] = [];
  const parser = new SaxesParser();
  parser.on("opentag", (tag) => {
    events.push({
      type: "open",
      name: tag.name,
      attributes: Object.entries(tag.attributes),
    });
  });
  parser.on("text", (value) => {
    events.push({ type: "text", value });
  });
  parser.on("cdata", (value) => {
    events.push({ type: "text", value });
  });
  parser.on("closetag", (tag) => {
    events.push({ type: "close", name: tag.name });
  });
  parser.write(xml).close();
  return events;
};

test("reads and transforms qualified elements in document order", () => {
  const xml =
    '<root><dc:title lang="en">One</dc:title><dc:title>Two</dc:title><x:item/><plain>keep</plain></root>';
  const first = firstXmlElement(xml, "dc:title");

  expect(
    first.kind === "found"
      ? xml.slice(first.match.contentStart, first.match.contentEnd)
      : null,
  ).toBe("One");
  expect(xmlElementText(xml, "dc:title")).toBe("One");
  expect(clearXmlElements(xml, ["dc:title"]).unwrap()).toBe(
    '<root><dc:title lang="en"></dc:title><dc:title></dc:title><x:item/><plain>keep</plain></root>',
  );
  expect(replaceXmlElementContent(xml, "x:item", "value").unwrap()).toContain(
    "<x:item>value</x:item>",
  );
  expect(removeXmlElements(xml, { prefix: "dc" }).unwrap()).toBe(
    "<root><x:item/><plain>keep</plain></root>",
  );
});

test("distinguishes element names that share a prefix", () => {
  const xml = "<w:p><w:pPr></w:pPr><w:r>text</w:r></w:p>";
  expect(replaceXmlElementContent(xml, "w:p", "updated").unwrap()).toBe(
    "<w:p>updated</w:p>",
  );
});

test("matches nested elements of the same name as one outer element", () => {
  const twoLevels =
    '<w:p w:rsidR="1"><w:pPr/><w:p/><w:txbxContent><w:p>inner</w:p></w:txbxContent></w:p>';
  const threeLevels =
    "<w:p><w:p><w:p>deep</w:p></w:p><w:pPr>style</w:pPr></w:p>";

  expect(replaceXmlElementContent(twoLevels, "w:p", "updated").unwrap()).toBe(
    '<w:p w:rsidR="1">updated</w:p>',
  );
  expect(replaceXmlElementContent(threeLevels, "w:p", "updated").unwrap()).toBe(
    "<w:p>updated</w:p>",
  );
});

test("matches nested elements selected by namespace prefix", () => {
  const xml =
    "<root><w:p><w:p>inner</w:p></w:p><w:r>keep</w:r><x:p>other</x:p></root>";

  expect(removeXmlElements(xml, { prefix: "w" }).unwrap()).toBe(
    "<root><x:p>other</x:p></root>",
  );
});

test("skips non-element markup around and within matching elements", () => {
  const cases = [
    "<!-- <p>opening</p> </p> -->",
    "<![CDATA[ <p>opening</p> </p> ]]>",
    "<?reader <p>opening</p> </p> ?>",
  ];

  for (const markup of cases) {
    const xml = `${markup}<p data-id="outer">before${markup}<q>text</q>after</p>`;
    const result = firstXmlElement(xml, "p");

    expect(result.kind).toBe("found");
    if (result.kind !== "found") {
      continue;
    }
    expect(result.match.start).toBe(markup.length);
    expect(result.match.end).toBe(xml.length);
    expect(xml.slice(result.match.contentStart, result.match.contentEnd)).toBe(
      `before${markup}<q>text</q>after`,
    );
    expect(replaceXmlElementContent(xml, "p", "updated").unwrap()).toBe(
      `${markup}<p data-id="outer">updated</p>`,
    );
  }
});

test("reports incomplete non-element markup", () => {
  for (const xml of ["<root><!-- <p></p>", "<root><![CDATA[ <p></p>"]) {
    expect(firstXmlElement(xml, "p")).toEqual({ kind: "incomplete" });
    expect(replaceXmlElements(xml, "p", () => "").isErr()).toBe(true);
  }
});

test("matches a reference parser with generated non-element markup", () => {
  const markup = fc.constantFrom(
    "<!-- <p>open</p> </p> -->",
    "<![CDATA[ <p>open</p> </p> ]]>",
  );
  assertProperty(
    "matches a reference parser with generated non-element markup",
    fc.property(
      fc.array(markup, { maxLength: 8 }),
      fc.array(markup, { maxLength: 8 }),
      fc.array(markup, { maxLength: 8 }),
      (before, inside, after) => {
        const prefix = before.join("");
        const suffix = after.join("");
        const xml = `<root>${prefix}<p><p>nested</p>${inside.join("")}text</p>${suffix}</root>`;
        const expected = `<root>${prefix}<p>updated</p>${suffix}</root>`;

        expect(parseXmlWithOracle(xml)).toBeDefined();
        const actual = replaceXmlElementContent(xml, "p", "updated").unwrap();
        expect(parseXmlWithOracle(actual)).toEqual(
          parseXmlWithOracle(expected),
        );
      },
    ),
  );
});

test("matches a reference parser for generated nested documents", () => {
  assertProperty(
    "matches a reference parser for generated nested documents",
    fc.property(
      fc.array(fc.integer({ min: 1, max: 8 }), {
        minLength: 1,
        maxLength: 20,
      }),
      (depths) => {
        const elements = depths.map((depth, index) => {
          const opening = `<p data-index="${String(index)}">`;
          const nestedOpening = "<p><pPr/><p/>".repeat(depth - 1);
          const nestedClosing = "</p>".repeat(depth - 1);
          return `${opening}${nestedOpening}value${nestedClosing}</p>`;
        });
        const xml = `<root>${elements.join("")}</root>`;
        expect(parseXmlWithOracle(xml)).toBeDefined();

        const expected = `<root>${depths
          .map((_, index) => `<p data-index="${String(index)}">updated</p>`)
          .join("")}</root>`;
        const actual = replaceXmlElementContent(xml, "p", "updated").unwrap();

        expect(parseXmlWithOracle(actual)).toEqual(
          parseXmlWithOracle(expected),
        );
        expect(actual).toBe(expected);
      },
    ),
  );
});

test("matches a regular-expression reference for well-formed flat elements", () => {
  assertProperty(
    "matches a regular-expression reference for well-formed flat elements",
    fc.property(
      fc.array(
        fc.record({
          content: fc.stringMatching(/^[A-Za-z0-9 ]{0,30}$/u),
          marked: fc.boolean(),
        }),
        { maxLength: 30 },
      ),
      (entries) => {
        const xml = entries
          .map(({ content, marked }) =>
            marked ? `<p data-x="1">${content}</p>` : `<q>${content}</q>`,
          )
          .join("");
        const referencePattern = "(<p(?:\\s[^>]*)?>)[\\s\\S]*?(</p>)";
        const reference = new RegExp(referencePattern, "gu");
        const expected = xml.replace(reference, "$1value$2");
        expect(replaceXmlElementContent(xml, "p", "value").unwrap()).toBe(
          expected,
        );
      },
    ),
  );
});

test("completes a one-megabyte incomplete document scan within the budget", () => {
  const xml = "<item>".repeat(Math.ceil((1024 * 1024) / 6));
  const started = performance.now();
  const result = replaceXmlElements(xml, "item", () => "");
  const elapsed = performance.now() - started;

  expect(result.isErr()).toBe(true);
  expect(elapsed).toBeLessThan(200);
});

test("completes a deeply nested one-megabyte document scan within the budget", () => {
  const depth = Math.floor((1024 * 1024) / 13);
  const xml = `${"<item>".repeat(depth)}${"</item>".repeat(depth)}`;
  const started = performance.now();
  const result = replaceXmlElements(xml, "item", () => "");
  const elapsed = performance.now() - started;

  expect(result.unwrap()).toBe("");
  expect(elapsed).toBeLessThan(200);
});

test("completes a one-megabyte comment-rich scan within the budget", () => {
  const comment = "<!-- <item></item> -->";
  const xml = comment.repeat(Math.ceil((1024 * 1024) / comment.length));
  const started = performance.now();
  const result = replaceXmlElements(xml, "item", () => "");
  const elapsed = performance.now() - started;

  expect(result.unwrap()).toBe(xml);
  expect(elapsed).toBeLessThan(200);
});

test("write helpers refuse an incomplete matching element", () => {
  const xml = '<item value="unfinished <item>closed</item>';

  const results = [
    replaceXmlElements(xml, "item", () => ""),
    replaceXmlElementContent(xml, "item", "value"),
    clearXmlElements(xml, ["item"]),
    removeXmlElements(xml, "item"),
  ];
  for (const result of results) {
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(XmlScanError.is(result.error)).toBe(true);
    }
  }
});

test("reads an open tag containing a closing bracket in an attribute", () => {
  const xml = '<item value=">">content</item>';
  const match = firstXmlElement(xml, "item");

  expect(match.kind === "found" ? match.match.openTag : null).toBe(
    '<item value=">">',
  );
  expect(xmlElementText(xml, "item")).toBe("content");
});

test("distinguishes incomplete and absent elements", () => {
  expect(firstXmlElement("<root><item>", "item")).toEqual({
    kind: "incomplete",
  });
  expect(firstXmlElement("<root></root>", "item")).toEqual({
    kind: "absent",
  });
});

test("keeps the attributes of a self-closing element when filling it", () => {
  const xml =
    '<Properties><ep:TotalTime xmlns:ep="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" /></Properties>';

  expect(replaceXmlElementContent(xml, "ep:TotalTime", "0").unwrap()).toBe(
    '<Properties><ep:TotalTime xmlns:ep="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">0</ep:TotalTime></Properties>',
  );
  expect(replaceXmlElementContent("<a><b/></a>", "b", "x").unwrap()).toBe(
    "<a><b>x</b></a>",
  );
});
