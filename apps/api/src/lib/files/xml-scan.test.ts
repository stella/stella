import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  clearXmlElements,
  firstXmlElement,
  removeXmlElements,
  replaceXmlElementContent,
  replaceXmlElements,
  xmlElementText,
} from "./xml-scan";

test("reads and transforms qualified elements in document order", () => {
  const xml =
    '<root><dc:title lang="en">One</dc:title><dc:title>Two</dc:title><x:item/><plain>keep</plain></root>';
  const first = firstXmlElement(xml, "dc:title");

  expect(
    first === null ? null : xml.slice(first.contentStart, first.contentEnd),
  ).toBe("One");
  expect(xmlElementText(xml, "dc:title")).toBe("One");
  expect(clearXmlElements(xml, ["dc:title"])).toBe(
    '<root><dc:title lang="en"></dc:title><dc:title></dc:title><x:item/><plain>keep</plain></root>',
  );
  expect(replaceXmlElementContent(xml, "x:item", "value")).toContain(
    "<x:item>value</x:item>",
  );
  expect(removeXmlElements(xml, { prefix: "dc" })).toBe(
    "<root><x:item/><plain>keep</plain></root>",
  );
});

test("distinguishes element names that share a prefix", () => {
  const xml = "<w:p><w:pPr></w:pPr><w:r>text</w:r></w:p>";
  expect(replaceXmlElementContent(xml, "w:p", "updated")).toBe(
    "<w:p>updated</w:p>",
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
        expect(replaceXmlElementContent(xml, "p", "value")).toBe(expected);
      },
    ),
  );
});

test("completes a one-megabyte incomplete document scan within the budget", () => {
  const xml = "<item>".repeat(Math.ceil((1024 * 1024) / 6));
  const started = performance.now();
  const result = replaceXmlElements(xml, "item", () => "");
  const elapsed = performance.now() - started;

  expect(result).toBe(xml);
  expect(elapsed).toBeLessThan(200);
});
