import { PDF } from "@libpdf/core";
import { expect, test } from "bun:test";
import * as fc from "fast-check";
import * as v from "valibot";

import { persistedDocumentAstSchema } from "@stll/legal-ast/document-ast";
import { assertProperty } from "@stll/property-testing";

import { SOFT_LAW_PDF_SHAPES } from "./__fixtures__/soft-law-ast/pdf-shapes";
import { buildSoftLawAst } from "./soft-law-ast";
import { SOFT_LAW_KINDS, type SoftLawDocumentInput } from "./soft-law-types";

const metadata = {
  title: "Synthetic guidance",
  kind: "guideline",
  statedReference: { state: "not_stated" },
  issuedOn: { state: "not_stated" },
  validity: { state: "not_stated", basis: "source_stated" },
  expression: {
    type: "identified",
    language: "en",
    revision: { state: "not_stated" },
  },
} as const satisfies SoftLawDocumentInput["metadata"];
const htmlInput = (html: string) =>
  ({
    metadata,
    text: html,
    extractionQuality: "html",
    sourceDates: {},
    raw: [
      {
        role: "document",
        purpose: "document",
        contentType: "text/html",
        bytes: new TextEncoder().encode(html),
      },
    ],
  }) as const satisfies SoftLawDocumentInput;
const options = {
  authority: "cz-uoou",
  documentId: "synthetic",
  sourceUrl: "https://example.test/guidance",
} as const;

test("HTML guidance retains sections, nested lists, tables, notes and formatting", async () => {
  const html = await Bun.file(
    new URL("__fixtures__/soft-law-ast/cz-uoou.html", import.meta.url),
  ).text();
  const result = await buildSoftLawAst({ ...options, input: htmlInput(html) });
  expect(result.type).toBe("readable");
  if (result.type !== "readable") {
    return;
  }
  const { blocks } = result.documentAst;
  expect(blocks.filter((block) => block.type === "heading")).toHaveLength(2);
  expect(
    blocks
      .filter((block) => block.type === "paragraph")
      .map((block) => block.listDepth),
  ).toContain(2);
  const table = blocks.find((block) => block.type === "table");
  expect(table?.rows).toHaveLength(2);
  expect(
    blocks.some((block) => block.plainText === "1. Uvede účel zpracování."),
  ).toBe(true);
  expect(
    blocks.some(
      (block) => block.plainText === "• Popíše jednotlivé kategorie údajů.",
    ),
  ).toBe(true);
  expect(table?.rows.at(0)?.at(0)?.header).toBe(true);
  expect(
    blocks
      .filter((block) => block.type === "paragraph")
      .find((block) => block.note)?.note,
  ).toMatchObject({ type: "footnote", label: "1" });
  expect(blocks.map((block) => block.plainText).join(" ")).not.toMatch(
    /hidden|Navigation/u,
  );
  expect(
    v.safeParse(persistedDocumentAstSchema, result.documentAst).success,
  ).toBe(true);
});

for (const authority of ["cz-uoou", "eu-edpb", "eu-wp29"] as const) {
  test(`PDF ${authority} guidance preserves numbered paragraphs, FAQ and footnotes`, async () => {
    const pdf = PDF.create();
    const page = pdf.addPage({ size: "letter" });
    for (const { text, y, size } of SOFT_LAW_PDF_SHAPES[authority]) {
      page.drawText(text, { x: 72, y, size });
    }
    const bytes = await pdf.save();
    const input: SoftLawDocumentInput = {
      metadata: {
        ...metadata,
        kind: authority === "eu-wp29" ? "faq" : "guideline",
      },
      text: "Extracted synthetic text",
      extractionQuality: "text_layer",
      sourceDates: {},
      raw: [
        {
          role: "document",
          purpose: "document",
          bytes,
          contentType: "application/pdf",
        },
      ],
    };
    const result = await buildSoftLawAst({ ...options, authority, input });
    expect(result.type).toBe("readable");
    if (result.type !== "readable") {
      return;
    }
    expect(
      v.safeParse(persistedDocumentAstSchema, result.documentAst).success,
    ).toBe(true);
    expect(await buildSoftLawAst({ ...options, authority, input })).toEqual(
      result,
    );
    if (authority === "eu-wp29") {
      expect(
        result.documentAst.blocks.filter((block) => block.type === "heading"),
      ).toHaveLength(2);
      expect(
        result.documentAst.blocks.filter((block) => block.type === "paragraph"),
      ).toHaveLength(2);
    } else {
      expect(
        result.documentAst.blocks.filter(
          (block) => block.type === "paragraph" && block.number !== undefined,
        ),
      ).toHaveLength(2);
    }
    if (authority === "eu-edpb") {
      const table = result.documentAst.blocks.find(
        (block) => block.type === "table",
      );
      expect(
        table?.rows.map((row) => row.map((cell) => cell.plainText)),
      ).toEqual([
        ["Category", "Retention"],
        ["Contact", "One year"],
      ]);
    }
    for (const block of result.documentAst.blocks) {
      if (block.type === "paragraph" && block.number !== undefined) {
        expect(block.plainText).not.toMatch(/^\d+[.)]\s/u);
      }
    }
    if (authority === "eu-edpb") {
      expect(
        result.documentAst.blocks
          .filter((block) => block.type === "paragraph")
          .find((block) => block.note)?.note,
      ).toMatchObject({ type: "footnote", label: "1" });
    }
  });
}

test("unreadable originals expose typed absence instead of empty ASTs", async () => {
  const base = htmlInput("<main><p>Original text</p></main>");
  const inputs: SoftLawDocumentInput[] = [
    { ...base, extractionQuality: "needs_ocr", text: null },
    { ...base, extractionQuality: "scanned_ocr", text: null },
    {
      ...base,
      extractionQuality: "extraction_failed",
      text: null,
      extractionFailure: "Synthetic failure",
    },
    htmlInput("<main></main>"),
    {
      ...base,
      raw: [
        {
          role: "page",
          contentType: "text/html",
          bytes: new TextEncoder().encode("<p>Discovery content</p>"),
          purpose: "discovery",
        },
      ],
    },
    {
      ...base,
      raw: [
        {
          role: "document",
          contentType: "application/pdf",
          bytes: new TextEncoder().encode("invalid pdf"),
        },
      ],
    },
  ];
  for (const input of inputs) {
    expect((await buildSoftLawAst({ ...options, input })).type).toBe(
      "original-only",
    );
  }
});

test("guidance AST rebuild is a persisted-schema fixed point", async () => {
  await assertProperty(
    "guidance AST rebuild is a persisted-schema fixed point",
    fc.asyncProperty(
      fc.constantFrom(...SOFT_LAW_KINDS),
      fc.array(fc.string({ maxLength: 80 }), { minLength: 1, maxLength: 8 }),
      async (kind, texts) => {
        const escape = (text: string) =>
          text
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;");
        const input = htmlInput(
          `<main><h1>Synthetic guidance</h1>${texts.map((text, index) => `<p>${index + 1}. ${escape(text)}</p>`).join("")}</main>`,
        );
        const withKind = { ...input, metadata: { ...metadata, kind } };
        const first = await buildSoftLawAst({ ...options, input: withKind });
        expect(first.type).toBe("readable");
        if (first.type !== "readable") {
          return;
        }
        const persisted = v.parse(
          persistedDocumentAstSchema,
          first.documentAst,
        );
        expect(persisted).toEqual(first.documentAst);
        expect(await buildSoftLawAst({ ...options, input: withKind })).toEqual(
          first,
        );
      },
    ),
  );
});

test("HTML numbered paragraphs separate printed numbering from their text", async () => {
  const result = await buildSoftLawAst({
    ...options,
    input: htmlInput(
      "<main><p><strong>1. </strong>First paragraph.</p><p>2. Second paragraph.</p></main>",
    ),
  });
  expect(result.type).toBe("readable");
  if (result.type !== "readable") {
    return;
  }
  expect(result.documentAst.blocks.map((block) => block.plainText)).toEqual([
    "First paragraph.",
    "Second paragraph.",
  ]);
  expect(
    result.documentAst.blocks.map((block) =>
      block.type === "paragraph" ? block.number : undefined,
    ),
  ).toEqual([1, 2]);
});

test("PDF guidance rebuild is a persisted-schema fixed point", async () => {
  await assertProperty(
    "PDF guidance rebuild is a persisted-schema fixed point",
    fc.asyncProperty(
      fc.constantFrom(...SOFT_LAW_KINDS),
      fc.array(fc.stringMatching(/^[A-Za-z ]{1,32}$/u), {
        minLength: 1,
        maxLength: 5,
      }),
      async (kind, texts) => {
        const pdf = PDF.create();
        const page = pdf.addPage({ size: "letter" });
        for (const [index, text] of texts.entries()) {
          page.drawText(`${index + 1}. Synthetic ${text}`, {
            x: 72,
            y: 720 - index * 30,
            size: 12,
          });
        }
        const bytes = await pdf.save();
        const input: SoftLawDocumentInput = {
          metadata: { ...metadata, kind },
          text: "Synthetic PDF",
          extractionQuality: "text_layer",
          sourceDates: {},
          raw: [
            {
              role: "document",
              purpose: "document",
              bytes,
              contentType: "application/pdf",
            },
          ],
        };
        const first = await buildSoftLawAst({ ...options, input });
        expect(first.type).toBe("readable");
        if (first.type !== "readable") {
          return;
        }
        expect(v.parse(persistedDocumentAstSchema, first.documentAst)).toEqual(
          first.documentAst,
        );
        expect(await buildSoftLawAst({ ...options, input })).toEqual(first);
      },
    ),
  );
});

test("list markers survive inter-element whitespace", async () => {
  await assertProperty(
    "list markers survive inter-element whitespace",
    fc.asyncProperty(
      fc
        .array(fc.constantFrom(" ", "\n", "\t", "\r"), { maxLength: 20 })
        .map((characters) => characters.join("")),
      async (whitespace) => {
        const input = htmlInput(
          `<main>${whitespace}<ol>${whitespace}<li>${whitespace}<p>${whitespace}First item.${whitespace}</p>${whitespace}<ul>${whitespace}<li>${whitespace}Nested item.${whitespace}</li>${whitespace}</ul>${whitespace}</li>${whitespace}<li>${whitespace}Second item.${whitespace}</li>${whitespace}</ol>${whitespace}</main>`,
        );
        const state = await buildSoftLawAst({ ...options, input });
        expect(state.type).toBe("readable");
        if (state.type !== "readable") {
          return;
        }
        expect(
          state.documentAst.blocks.map((block) => block.plainText),
        ).toEqual(["1. First item.", "• Nested item.", "2. Second item."]);
        expect(
          state.documentAst.blocks
            .filter((block) => block.type === "paragraph")
            .map((block) => block.number),
        ).toEqual([undefined, undefined, undefined]);
      },
    ),
  );
});

test("sibling article paragraphs survive exactly once", async () => {
  await assertProperty(
    "sibling article paragraphs survive exactly once",
    fc.asyncProperty(
      fc.array(fc.stringMatching(/^[A-Za-z]{1,20}$/u), {
        minLength: 2,
        maxLength: 8,
      }),
      async (texts) => {
        const input = htmlInput(
          `<body>${texts.map((text, index) => (index % 2 === 0 ? `<article><p>${text}</p></article>` : `<article><section><article><p>${text}</p></article></section></article>`)).join("")}</body>`,
        );
        const state = await buildSoftLawAst({ ...options, input });
        expect(state.type).toBe("readable");
        if (state.type !== "readable") {
          return;
        }
        expect(
          state.documentAst.blocks.map((block) => block.plainText),
        ).toEqual(texts);
      },
    ),
  );
});
