import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { opinionRow } from "@/api/handlers/case-law/ingestion/adapters/courtlistener/test-records";

import { createTextBudget } from "./outcome";
import { plainTextStructureOf } from "./plain-text-structure";
import { selectOpinionText } from "./select";

const select = (plain_text: string) =>
  selectOpinionText({
    row: opinionRow({ id: "1", cluster_id: "2", plain_text, xml_harvard: "" }),
    type: "020lead",
    budget: createTextBudget(),
  });

test("HTML stored in the plain text column keeps every paragraph", () => {
  const body = Array.from(
    { length: 30 },
    (_, index) => `<p>Invented paragraph ${index} preserves its words.</p>`,
  );
  const source = `<div><div>Opinion</div>${body.join("")}</div>`;
  expect(plainTextStructureOf(source)).toBe("html");
  const parsed = select(source);
  expect(parsed.status).toBe("parsed");
  if (parsed.status !== "parsed") {
    return;
  }
  expect(parsed.structure).toBe("html");
  const parsedBlocks = parsed.text.units.flatMap(({ blocks }) => [...blocks]);
  expect(parsedBlocks.map(({ plainText }) => plainText)).toEqual([
    "Opinion",
    ...Array.from(
      { length: 30 },
      (_, index) => `Invented paragraph ${index} preserves its words.`,
    ),
  ]);
});

test("literal and escaped markup in plain text keeps its source characters", () => {
  for (const source of [
    "The formula uses <n> terms and <k> factors.",
    "The exhibit prints <div><p>literal example</p></div> in prose.",
    "<div>quoted opener</div> The formula uses <p>terms</p> <div>quoted closer</div>",
    "&lt;div&gt;&lt;p&gt;escaped example&lt;/p&gt;&lt;/div&gt;",
    "<RXQJ\u0003Y\u0003 text > OCR words",
  ]) {
    expect(plainTextStructureOf(source)).toBe("plain");
    const parsed = select(source);
    expect(parsed.status).toBe("parsed");
    if (parsed.status === "parsed") {
      expect(parsed.structure).toBe("plain");
      expect(
        parsed.text.units.flatMap(({ blocks }) => [...blocks]).at(0)?.plainText,
      ).toBe(source);
    }
  }
});

test("structural HTML in plain columns conserves generated text", () => {
  assertProperty(
    "structural HTML in plain columns conserves generated text",
    fc.property(
      fc.array(fc.stringMatching(/^[a-z]{4,30}$/u), {
        minLength: 2,
        maxLength: 25,
      }),
      fc.constantFrom("div", "article", "section"),
      (words, root) => {
        const paragraphs = words.map((word) => `Invented ${word} content.`);
        const source = `<${root}>${paragraphs.map((text) => `<p>${text}</p>`).join("")}</${root}>`;
        expect(source).toContain("<p>");
        const parsed = select(source);
        expect(parsed.status).toBe("parsed");
        if (parsed.status !== "parsed") {
          return;
        }
        expect(parsed.structure).toBe("html");
        expect(
          parsed.text.units.flatMap(({ blocks }) =>
            blocks.map(({ plainText }) => plainText),
          ),
        ).toEqual(paragraphs);
        const mixed = `${source} The formula uses terms. ${source}`;
        expect(plainTextStructureOf(mixed)).toBe("plain");
        const literal = select(mixed);
        expect(literal.status).toBe("parsed");
        if (literal.status === "parsed") {
          expect(literal.structure).toBe("plain");
          expect(
            literal.text.units.flatMap(({ blocks }) =>
              blocks.map(({ plainText }) => plainText),
            ),
          ).toEqual([mixed]);
        }
        expect(plainTextStructureOf(Bun.escapeHTML(source))).toBe("plain");
        expect(plainTextStructureOf(`The exhibit prints ${source}.`)).toBe(
          "plain",
        );
      },
    ),
  );
});

test.each([
  "<div><p>The court affirms the judgment.</p></div>",
  "<html><body><p>The court affirms the judgment.</p></body></html>",
  "<p>The court affirms.</p> \n\t <div>The judgment stands.</div>",
  "<div>The court affirms the judgment.</div>",
])("structural roots separated only by whitespace are HTML: %s", (source) => {
  expect(plainTextStructureOf(source)).toBe("html");
  const parsed = select(source);
  expect(parsed.status).toBe("parsed");
  if (parsed.status === "parsed") {
    expect(parsed.structure).toBe("html");
  }
});
