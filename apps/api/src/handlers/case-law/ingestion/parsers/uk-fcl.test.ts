import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

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
      plainText: "Compare Invented Grove and section 2.",
    });
    expect(result.fulltext).not.toContain("Invented Fir Solicitors");
    expect(result.metadata.images.reason).toBe("not_collected");
    expect(
      result.documentAst.blocks.find(({ role }) => role === "counsel")
        ?.plainText,
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
