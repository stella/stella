import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import * as astValidation from "@/api/lib/legal-search/parsers/validate-ast";

import { parseUkFclDecision } from "./uk-fcl";

const xml = await readFile(
  new URL("__fixtures__/uk-fcl.xml", import.meta.url),
  "utf-8",
);
const parse = (source = xml) =>
  parseUkFclDecision({
    xml: source,
    documentId: "d-00000000-0000-4000-8000-000000000001",
    sourceUrl:
      "https://caselaw.nationalarchives.gov.uk/d-00000000-0000-4000-8000-000000000001",
  });

describe("LegalDocML judgment", () => {
  test("preserves identity, source fields and citation origins while separating front matter", () => {
    const result = parse().unwrap();
    expect(result.caseNumber).toBe("[2026] UKSC 900001");
    expect(result.court).toBe("UKSC");
    expect(result.decisionDate).toBe("2026-01-02");
    expect(result.caseName).toBe("Invented Amber v Invented Birch");
    expect(result.judges).toEqual([
      { role: "panel-member", nameAsPrinted: "Justice Invented Cedar" },
    ]);
    expect(
      result.metadata.parties.map(({ name, role }) => ({ name, role })),
    ).toEqual([
      { name: "Invented Amber", role: "Appellant" },
      { name: "Invented Birch", role: "Respondent" },
    ]);
    expect(
      result.metadata.inlineReferences.map(
        ({ attributes }) => attributes["uk:origin"],
      ),
    ).toEqual(["parser", "TNA", "parser"]);
    expect(
      result.documentAst.blocks.find(({ id }) => id === "para_2"),
    ).toMatchObject({
      number: 2,
      role: "argumentation",
      plainText: "2. Compare Invented Grove and section 2.",
    });
    expect(result.fulltext).not.toContain("Invented Fir Solicitors");
    expect(result.metadata.images.reason).toBe("not_collected");
    expect(
      result.documentAst.blocks.find(
        (block) => block.type === "paragraph" && block.role === "counsel",
      )?.plainText,
    ).toContain("Invented Fir Solicitors");
    expect(parse().unwrap()).toEqual(result);
  });

  test("namespace prefixes do not change judgment text or structure", () => {
    const prefixed = xml
      .replaceAll("xmlns:uk=", "xmlns:fcl=")
      .replaceAll("uk:", "fcl:");
    expect(prefixed).not.toBe(xml);
    const expected = parse().unwrap();
    const actual = parse(prefixed).unwrap();
    expect(actual.documentAst).toEqual(expected.documentAst);
  });

  test("unsafe rendered links retain their source attributes and text", () => {
    const unsafeHref = ["javascript", "alert(1)"].join(":");
    const unsafe = xml.replace(
      "https://caselaw.nationalarchives.gov.uk/uksc/2024/900003",
      () => unsafeHref,
    );
    const result = parse(unsafe).unwrap();
    expect(result.fulltext).toBe(parse().unwrap().fulltext);
    expect(JSON.stringify(result.documentAst)).not.toContain(unsafeHref);
    expect(result.metadata.inlineReferences.at(1)?.attributes["href"]).toBe(
      unsafeHref,
    );
  });

  test("CDATA and unstructured header text remain recoverable", () => {
    const source = xml
      .replace("<header>", "<header>Unstructured header text")
      .replace("synthetic-parser-1", "<![CDATA[synthetic-parser-1]]>");
    const result = parse(source).unwrap();
    expect(result.metadata.xmlFields["uk:parser"]).toEqual([
      { text: "synthetic-parser-1", attributes: {} },
    ]);
    expect(
      result.documentAst.blocks.map(({ plainText }) => plainText.trim()),
    ).toContain("Unstructured header text");
    expect(result.fulltext).toBe(parse().unwrap().fulltext);
  });

  test("malformed XML and missing authoritative fields produce typed failures", () => {
    for (const source of [
      xml.slice(0, -20),
      xml
        .replace("<akomaNtoso ", "<wrapper><akomaNtoso ")
        .replace("</akomaNtoso>", "</akomaNtoso></wrapper>"),
      xml.replace(/xmlns="[^"]+"/u, 'xmlns="urn:invalid"'),
      xml.replace("<uk:court>UKSC</uk:court>", ""),
      xml.replace('2026-01-02" name="judgment', '2026-02-30" name="judgment'),
    ]) {
      const result = parse(source);
      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error._tag).toBe("ParseXmlError");
      }
    }
  });
});

const withBody = (body: string) =>
  xml.replace(
    /<judgmentBody>[\s\S]*<\/judgmentBody>/u,
    () => `<judgmentBody>${body}</judgmentBody>`,
  );

test.each(["1.", "(a)", "(i)", "A.", "(iv)"])(
  "preserves the complete paragraph label %s",
  (label) => {
    const source = withBody(
      `<paragraph eId="labelled"><num>${label}</num><content><p>The invented boundary remains blue.</p></content></paragraph>`,
    );
    const result = parse(source).unwrap();
    expect(result.fulltext).toBe(
      `${label} The invented boundary remains blue.`,
    );
    expect(
      result.documentAst.blocks.find(({ id }) => id === "labelled")?.plainText,
    ).toBe(result.fulltext);
  },
);

test("adjacent paragraphs, cells and list items retain their boundaries without indentation", () => {
  const source = withBody(
    '<paragraph eId="multi"><num>7.</num><content><p>First sentence.</p><p>Second sentence.</p><table><tr><td>Amber</td><td>Birch</td></tr><tr><td><p>Cedar</p><p>Dune</p></td><td>Elm</td></tr></table><blockList><item><num>(i)</num><p>First item.</p></item><item><num>(ii)</num><p>Second item.</p></item></blockList></content></paragraph>',
  );
  const result = parse(source).unwrap();
  expect(result.fulltext.split("\n\n")).toEqual([
    "7. First sentence.",
    "Second sentence.",
    "Amber",
    "Birch",
    "Cedar",
    "Dune",
    "Elm",
    "(i) First item.",
    "(ii) Second item.",
  ]);
  expect(new Set(result.documentAst.blocks.map(({ id }) => id)).size).toBe(
    result.documentAst.blocks.length,
  );
});

test("the shared validator reports complete output with degraded structure", () => {
  const source = withBody(
    '<paragraph eId="degraded"><num>(a)</num><p>Invented prose with no published heading.</p></paragraph>',
  );
  const result = parse(source).unwrap();
  const validation = astValidation.validateAndLog(
    { parser: "uk-fcl", caseNumber: result.caseNumber, language: "en" },
    {
      type: "paragraphs",
      paragraphs: [
        result.metadata.header ?? "",
        "(a) Invented prose with no published heading.",
      ],
    },
    result.documentAst.blocks,
  );
  expect(validation.ok).toBe(true);
  expect(validation.issues.map(({ code }) => code)).toContain("NO_HEADINGS");
});

test("explicit line breaks preserve word boundaries and inline formatting", () => {
  const source = withBody(
    '<paragraph eId="breaks"><p>First<br/><b>Second</b> and pre<i>fix</i>.</p></paragraph>',
  );
  const result = parse(source).unwrap();
  expect(result.fulltext).toBe("First\nSecond and prefix.");
  expect(
    result.documentAst.blocks
      .filter((block) => block.type === "paragraph")
      .find(({ id }) => id === "breaks")?.inlines,
  ).toContainEqual({
    type: "bold",
    children: [{ type: "text", text: "Second" }],
  });
});

test("continuation anchors cannot collide with published header or body identifiers", () => {
  const source = withBody(
    '<paragraph eId="p"><p>First invented point.</p><p>Second invented point.</p></paragraph><paragraph eId="p-2"><p>Third invented point.</p></paragraph>',
  ).replace("<header>", '<header><p eId="p-3">Invented header.</p>');
  const result = parse(source).unwrap();
  const ids = result.documentAst.blocks.map(({ id }) => id);
  expect(ids).toContain("p");
  expect(ids).toContain("p-2");
  expect(ids).toContain("p-3");
  expect(new Set(ids).size).toBe(ids.length);
  expect(
    result.documentAst.blocks.find(({ id }) => id === "p-2")?.plainText,
  ).toBe("Third invented point.");
});

test("a fallback anchor collision keeps the first block's numeric paragraph metadata", () => {
  const source = withBody(
    '<paragraph><num>1.</num><p>First invented point.</p></paragraph><paragraph eId="argumentation-0"><p>Second invented point.</p></paragraph>',
  ).replace(/<header>[\s\S]*?<\/header>/u, "");
  const result = parse(source).unwrap();
  expect(result.documentAst.blocks.at(0)).toMatchObject({
    type: "paragraph",
    number: 1,
    plainText: "1. First invented point.",
  });
  expect(result.documentAst.blocks.at(1)?.id).toBe("argumentation-0");
});
