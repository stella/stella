import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import {
  documentAstSchema,
  omitDerivablePlainText,
  parseDocumentAst,
} from "@stll/legal-ast/document-ast";
import type {
  Block,
  DocumentAst,
  GuidanceMetadata,
} from "@stll/legal-ast/document-ast";
import { assertProperty } from "@stll/property-testing";

import { buildHtmlDocumentAst } from "./html-document-ast";

const METADATA = {
  type: "guidance",
  kind: "guideline",
  title: "Guidelines 1/2026",
  reference: "Guidelines 1/2026",
  issuedOn: "2026-01-15",
  issuer: {
    type: "authority",
    name: "European Data Protection Board",
    jurisdiction: "EU",
  },
} satisfies GuidanceMetadata;

const SOURCE = {
  system: "edpb.europa.eu",
  documentId: "guidelines-1-2026",
  webUrl: "https://publisher.test/guidelines-1-2026",
  printUrl: "",
};

const build = (body: string): DocumentAst =>
  buildHtmlDocumentAst({
    html: `<html><body><nav>Menu</nav><article id="text">${body}</article></body></html>`,
    contentRoot: "#text",
    baseUrl: SOURCE.webUrl,
    source: SOURCE,
    metadata: METADATA,
  }).unwrap();

const outline = (ast: DocumentAst) =>
  ast.blocks.map((block) => ({
    id: block.id,
    type: block.type,
    text: block.plainText,
    ...(block.type === "paragraph" && block.note !== undefined
      ? { note: block.note.label }
      : {}),
  }));

describe("the HTML builder", () => {
  test("reads headings, paragraphs and lists inside the content root only", () => {
    const ast = build(`
      <h1>Guidelines 1/2026</h1>
      <h2>1 Introduction</h2>
      <p>First   paragraph
         spans lines.</p>
      <ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul>
      <blockquote><p>Quoted text.</p></blockquote>
      <h2>2 Scope</h2>
      loose text
      <p>Last.</p>`);
    expect(
      ast.blocks.map((block) => [
        block.id,
        block.plainText,
        block.type === "paragraph" ? (block.listDepth ?? block.role ?? "") : "",
      ]),
    ).toEqual([
      ["s-guidelines-1-2026", "Guidelines 1/2026", ""],
      ["s-1", "1 Introduction", ""],
      ["s-1_1", "First paragraph spans lines.", ""],
      ["s-1_2", "one", 1],
      ["s-1_3", "two", 1],
      ["s-1_4", "nested", 2],
      ["s-1_5", "Quoted text.", "quote"],
      ["s-2", "2 Scope", ""],
      ["s-2_1", "loose text", ""],
      ["s-2_2", "Last.", ""],
    ]);
    expect(ast.metadata).toEqual(METADATA);
  });

  test("sets footnotes after the body under the mark the body printed", () => {
    const ast = build(`
      <p>Body<sup><a href="#fn1" id="r1">1</a></sup> and Word style<a href="#_ftn2" name="_ftnref2">[2]</a>.</p>
      <ol class="notes"><li id="fn1">First note. <a href="#r1">↩</a></li></ol>
      <div id="ftn2"><p><a href="#_ftnref2" name="_ftn2">[2]</a> Second note.</p></div>`);
    expect(outline(ast)).toEqual([
      { id: "front_1", type: "paragraph", text: "Body1 and Word style2." },
      { id: "fn-1", type: "paragraph", text: "First note. ↩", note: "1" },
      { id: "fn-2", type: "paragraph", text: "Second note.", note: "2" },
    ]);
    const [body] = ast.blocks;
    expect(body?.type === "paragraph" ? body.inlines : []).toContainEqual({
      type: "superscript",
      children: [{ type: "text", text: "1" }],
    });
  });

  test("reads a malformed fragment escape as printed instead of failing", () => {
    const ast = build(
      `<p>Body<a href="#fn%E0">1</a></p><p id="fn%E0">The note.</p>`,
    );
    expect(outline(ast)).toEqual([
      { id: "front_1", type: "paragraph", text: "Body1" },
      { id: "fn-1", type: "paragraph", text: "The note.", note: "1" },
    ]);
  });

  test("cites legislation from a link, with the version the link applies", () => {
    const ast = build(
      `<p>See <a href="https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:02016R0679-20160504">the GDPR</a> and Directive 95/46/EC.</p>`,
    );
    const [paragraph] = ast.blocks;
    expect(paragraph?.type === "paragraph" ? paragraph.inlines : []).toEqual([
      { type: "text", text: "See " },
      {
        type: "citation",
        cite: "the GDPR",
        href: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:02016R0679-20160504",
        children: [{ type: "text", text: "the GDPR" }],
        target: {
          status: "legislation",
          series: "eu-regulation",
          year: 2016,
          number: 679,
          appliedVersion: { date: "2016-05-04" },
        },
      },
      { type: "text", text: " and " },
      {
        type: "citation",
        cite: "Directive 95/46/EC",
        children: [{ type: "text", text: "Directive 95/46/EC" }],
        target: {
          status: "legislation",
          series: "eu-directive",
          year: 1995,
          number: 46,
        },
      },
      { type: "text", text: "." },
    ]);
  });

  test("resolves relative links and drops unsafe ones", () => {
    const ast = build(
      `<p><a href="/docs/a.pdf">PDF</a> <a href="javascript:alert(1)">bad</a></p>`,
    );
    const [paragraph] = ast.blocks;
    expect(paragraph?.type === "paragraph" ? paragraph.inlines : []).toEqual([
      {
        type: "link",
        href: "https://publisher.test/docs/a.pdf",
        children: [{ type: "text", text: "PDF" }],
      },
      { type: "text", text: " bad" },
    ]);
  });

  test("reads a table cell by cell", () => {
    const ast = build(
      `<table><tr><th colspan="2">Version</th></tr><tr><td>2.0</td><td>Adopted</td></tr></table>`,
    );
    expect(ast.blocks).toEqual([
      {
        id: "front_1",
        anchorId: "front_1",
        type: "table",
        rows: [
          [
            {
              inlines: [{ type: "text", text: "Version" }],
              plainText: "Version",
              colSpan: 2,
              header: true,
            },
          ],
          [
            { inlines: [{ type: "text", text: "2.0" }], plainText: "2.0" },
            {
              inlines: [{ type: "text", text: "Adopted" }],
              plainText: "Adopted",
            },
          ],
        ],
        plainText: "Version\n2.0\tAdopted",
      },
    ]);
  });

  test("fails when the content root is missing or empty", () => {
    const failureOf = (html: string) => {
      const result = buildHtmlDocumentAst({
        html,
        contentRoot: "#text",
        baseUrl: SOURCE.webUrl,
        source: SOURCE,
        metadata: METADATA,
      });
      return result.status === "error" ? result.error.reason : null;
    };
    expect(failureOf("<p>x</p>")).toBe("no-content-root");
    expect(failureOf(`<div id="text"><nav>Menu</nav></div>`)).toBe("no-blocks");
  });
});

/** Words that survive HTML whitespace collapsing unchanged. */
const word = fc.constantFrom(
  "Regulation (EU) 2016/679",
  "zákon č. 110/2019 Sb.",
  "Článek",
  "données",
  "§ 5",
  "a",
  "b",
);
const words = fc.array(word, { minLength: 1, maxLength: 4 });

type GeneratedBlock =
  | { type: "heading"; level: 1 | 2 | 3; label: string | null; words: string[] }
  | { type: "paragraph"; words: string[]; note: boolean }
  | { type: "list"; items: string[][] };

const generatedBlock: fc.Arbitrary<GeneratedBlock> = fc.oneof(
  fc.record({
    type: fc.constant("heading" as const),
    level: fc.constantFrom(1 as const, 2 as const, 3 as const),
    label: fc.option(fc.constantFrom("1", "2.1", "Annex II"), { nil: null }),
    words,
  }),
  fc.record({
    type: fc.constant("paragraph" as const),
    words,
    note: fc.boolean(),
  }),
  fc.record({
    type: fc.constant("list" as const),
    items: fc.array(words, { minLength: 1, maxLength: 3 }),
  }),
);

const render = (blocks: readonly GeneratedBlock[]): string => {
  const notes: string[] = [];
  const body = blocks
    .map((block) => {
      switch (block.type) {
        case "heading": {
          const label = block.label === null ? "" : `${block.label} `;
          return `<h${block.level}>${label}${block.words.join(" ")}</h${block.level}>`;
        }
        case "paragraph": {
          if (!block.note) {
            return `<p>\n  ${block.words.join("\n  ")}\n</p>`;
          }
          notes.push(block.words.join(" "));
          const n = notes.length;
          return `<p>${block.words.join(" ")}<a href="#fn${n}">${n}</a></p>`;
        }
        case "list": {
          return `<ul>${block.items.map((item) => `<li>${item.join(" ")}</li>`).join("")}</ul>`;
        }
        default: {
          block satisfies never;
          return "";
        }
      }
    })
    .join("\n");
  const noteList = notes
    .map((text, index) => `<p id="fn${index + 1}">${text}</p>`)
    .join("");
  return `${body}<div>${noteList}</div>`;
};

const document = fc.array(generatedBlock, { minLength: 1, maxLength: 8 });

const textOfBlocks = (blocks: readonly Block[]): string =>
  blocks.map((block) => block.plainText).join(" ");

describe("HTML builder output", () => {
  test("is a valid document that round-trips through the persisted reader", () => {
    assertProperty(
      "is a valid document that round-trips through the persisted reader",
      fc.property(document, (blocks) => {
        const ast = build(render(blocks));
        expect(v.is(documentAstSchema, ast)).toBe(true);
        expect(parseDocumentAst(omitDerivablePlainText(ast))).toEqual(ast);
        expect(parseDocumentAst(JSON.stringify(ast))).toEqual(ast);
      }),
    );
  });

  test("keeps every word and gives every block a unique, repeatable id", () => {
    assertProperty(
      "keeps every word and gives every block a unique, repeatable id",
      fc.property(document, (blocks) => {
        const html = render(blocks);
        const ast = build(html);
        const ids = ast.blocks.map(({ id }) => id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ast.blocks.every(({ anchorId, id }) => anchorId === id)).toBe(
          true,
        );
        expect(build(html)).toEqual(ast);
        const text = textOfBlocks(ast.blocks);
        for (const block of blocks) {
          const expected =
            block.type === "list" ? block.items.flat() : block.words;
          for (const piece of expected) {
            expect(text).toContain(piece);
          }
        }
      }),
    );
  });

  test("keeps ids outside an edited section", () => {
    assertProperty(
      "keeps ids outside an edited section",
      fc.property(document, document, words, (before, after, inserted) => {
        const edited: GeneratedBlock[] = [
          ...before,
          { type: "heading", level: 2, label: "9", words: ["Edited"] },
          { type: "paragraph", words: inserted, note: false },
          { type: "heading", level: 2, label: "10", words: ["Next"] },
          ...after.filter((block) => block.type !== "paragraph" || !block.note),
        ];
        const original = edited.filter(
          (_, index) => index !== before.length + 1,
        );
        const idsAfter = (ast: DocumentAst) =>
          ast.blocks
            .slice(ast.blocks.findIndex(({ id }) => id === "s-10"))
            .map(({ id, plainText }) => `${id}:${plainText}`);
        expect(idsAfter(build(render(edited)))).toEqual(
          idsAfter(build(render(original))),
        );
      }),
    );
  });
});
