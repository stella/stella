import { describe, expect, test } from "bun:test";

import type { Block, Inline } from "@stll/legal-ast/document-ast";
import { hasInlineChildren } from "@stll/legal-ast/document-ast";

import { parseSkUsDocumentXhtml } from "@/api/handlers/case-law/ingestion/parsers/sk-us";
import { readGzipJson } from "@/api/lib/gzip-json";

const FIXTURES = new URL("../adapters/__fixtures__/", import.meta.url);

const parse = (xhtml: string) =>
  parseSkUsDocumentXhtml({
    xhtml,
    caseNumber: "PL. ÚS 11/2021",
    ecli: "ECLI:SK:USSR:2021:PL.US.11.2021.2",
    court: "Ústavný súd SR",
    decisionDate: "2021-07-29",
    decisionType: "uznesenie",
    documentUrl: "https://www.ustavnysud.sk/docDownload/75f2386e",
  });

/** Every inline of a document, flattened, so a test can look for one. */
const inlinesOf = (blocks: readonly Block[]): Inline[] => {
  const flat: Inline[] = [];
  const walk = (inlines: readonly Inline[]): void => {
    for (const inline of inlines) {
      flat.push(inline);
      if (hasInlineChildren(inline)) {
        walk(inline.children);
      }
    }
  };
  for (const block of blocks) {
    if (block.type === "heading" || block.type === "paragraph") {
      walk(block.inlines);
    }
  }
  return flat;
};

const roleOf = (block: Block): string | undefined =>
  "role" in block ? block.role : undefined;

describe("the document the court renders as markup", () => {
  test("reads its parts from the words the court prints, not from tags", async () => {
    const payload = await readGzipJson(
      new URL("sk-us-content.json.gz", FIXTURES),
    );
    const content =
      typeof payload === "object" &&
      payload !== null &&
      "content" in payload &&
      typeof payload.content === "string"
        ? payload.content
        : "";
    const { documentAst, fulltext } = parse(
      Buffer.from(content, "base64").toString("utf-8"),
    );

    // There is no paragraph or heading element in the markup: every one of
    // these was read off the font size and the court's own section words,
    // spaced out as it prints them (`rozh od ol :`).
    const headings = documentAst.blocks.filter(
      (block) => block.type === "heading",
    );
    expect(headings.map((block) => block.plainText.trim())).toEqual([
      "OPRAVNÉ UZNESENIE",
      "rozh od ol :",
      "O d ôvod n eni e:",
    ]);
    expect(headings.at(0)).toMatchObject({ role: "decision-title" });
    expect(
      documentAst.blocks.filter((block) => roleOf(block) === "holding"),
    ).toHaveLength(2);
    expect(documentAst.blocks.map(roleOf)).toContain("closing");
    expect(documentAst.blocks.map(roleOf)).toContain("signature");
    // The page footer is the court's, not the decision's.
    expect(fulltext).not.toMatch(/^\s*2\s*$/mu);
  });

  test("a hidden run reaches neither the text nor the tree", () => {
    const secret = "Ján Novák, Hlavná 1, Košice";
    const { documentAst, fulltext } = parse(
      `<html><body><div><span style="font-size: 12px; ">Sťažovateľ <br/>` +
        `</span><span style="color: #000000; background-color: #000000; font-size: 12px; ">${secret}</span>` +
        `<span style="font-size: 12px; "> podal sťažnosť. <br/></span></div></body></html>`,
    );

    // The court paints anonymized text the colour of its own background. A
    // parser that read the span as text would publish what the court hid.
    expect(fulltext).not.toContain(secret);
    expect(JSON.stringify(documentAst)).not.toContain(secret);
    expect(JSON.stringify(documentAst)).not.toContain("Novák");
    // The gap is still stated: a reader has to see that something stood there.
    expect(
      inlinesOf(documentAst.blocks).some(
        (inline) => inline.type === "text" && inline.anonymized === true,
      ),
    ).toBe(true);
  });

  test("the run the court actually hides carries no words at all", () => {
    const { fulltext } = parse(
      `<html><body><div><span style="font-size: 12px; ">Sťažovateľ <br/>` +
        `</span><span style="color: #000000; background-color: #000000; font-size: 12px; ">${"&nbsp;".repeat(
          40,
        )}</span>` +
        `<span style="font-size: 12px; "> podal sťažnosť. <br/></span></div></body></html>`,
    );

    // Verified against the live service: the hidden span is a run of
    // non-breaking spaces, so what it replaces is gone rather than hidden.
    // Kept out of the text anyway: forty spaces are not something the
    // decision says.
    expect(fulltext).not.toMatch(/\u00a0{4}/u);
    expect(fulltext).toContain("podal sťažnosť.");
  });

  test("keeps body text outside spans, including paragraphs and table cells", () => {
    const { documentAst, fulltext } = parse(
      "<html><body>Voľný úvod.<p>Text odseku.</p>" +
        "<table><tr><td>Text bunky A.</td><td><span>Text bunky B.</span></td></tr></table>" +
        "Voľný záver.</body></html>",
    );

    for (const text of [
      "Voľný úvod.",
      "Text odseku.",
      "Text bunky A.",
      "Text bunky B.",
      "Voľný záver.",
    ]) {
      expect(fulltext).toContain(text);
      expect(JSON.stringify(documentAst)).toContain(text);
    }
  });
});

test("one-line Roman titles enter the outline without swallowing the following paragraph", () => {
  const { documentAst } = parse(
    "<html><body><span>Odôvodnenie:<br/>I. Ústavná sťažnosť<br/>Text odôvodnenia.<br/>II. A) Argumentácia<br/>Ďalší text.<br/></span></body></html>",
  );
  const headings = documentAst.blocks.filter(
    (block) => block.type === "heading",
  );
  expect(headings.map((block) => [block.plainText, block.level])).toEqual([
    ["Odôvodnenie:", 2],
    ["I. Ústavná sťažnosť", 3],
    ["II. A) Argumentácia", 4],
  ]);
  expect(
    documentAst.blocks
      .filter((block) => block.type === "paragraph")
      .map((block) => block.plainText),
  ).toEqual(["Text odôvodnenia.", "Ďalší text."]);
});

test("Roman verdict items keep their holding role while reasoning titles enter the outline", () => {
  const verdict = "I. Súd žalobu zamieta.";
  const { documentAst } = parse(
    `<html><body><span>rozhodol:<br/>${verdict}<br/>II. Náhradu nepriznáva.<br/>Odôvodnenie:<br/>I. Ústavná sťažnosť<br/>Text odôvodnenia.<br/></span></body></html>`,
  );
  expect(
    documentAst.blocks.find((block) => block.plainText.includes(verdict)),
  ).toMatchObject({ type: "paragraph", role: "holding" });
  expect(
    documentAst.blocks.find(
      (block) => block.plainText === "I. Ústavná sťažnosť",
    ),
  ).toMatchObject({ type: "heading", level: 3 });
  expect(
    documentAst.blocks
      .filter((block) => block.type === "heading")
      .map((block) => block.plainText),
  ).not.toContain(verdict);
});
