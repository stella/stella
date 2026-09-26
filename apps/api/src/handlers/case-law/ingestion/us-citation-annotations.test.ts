import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig, propertySeed } from "@stll/property-testing";

import { extractDecisionCitations } from "@/api/handlers/case-law/ingestion/citation-extractor";
import { annotateUsCitations } from "@/api/handlers/case-law/ingestion/us-citation-annotations";
import type { UsCitationOccurrence } from "@/api/handlers/case-law/ingestion/us-citation-occurrences";
import type { CitationWorkBudget } from "@/api/handlers/case-law/ingestion/us-citation-scanner";
import {
  hasInlineChildren,
  isDocumentAst,
  plainTextOf,
} from "@/api/lib/case-law/document-ast";
import type {
  Block,
  DocumentAst,
  Inline,
  ParagraphBlock,
} from "@/api/lib/case-law/document-ast";

const config = (numRuns: number) =>
  propertyConfig({ numRuns, seed: propertySeed() });

const paragraph = (id: string, inlines: Inline[]): ParagraphBlock => ({
  id,
  anchorId: `anchor-${id}`,
  type: "paragraph",
  inlines,
  plainText: plainTextOf(inlines).trim(),
});

const documentOf = (blocks: Block[]): DocumentAst => ({
  version: 1,
  source: { system: "test", documentId: "d", webUrl: "", printUrl: "" },
  metadata: {
    caseNumber: null,
    ecli: null,
    court: null,
    decisionDate: null,
    decisionType: null,
    keywords: [],
    statutes: [],
  },
  blocks,
});

const extract = (ast: DocumentAst) => {
  const result = extractDecisionCitations({
    country: "USA",
    sections: [],
    documentAst: ast,
    citationScopes: [
      { opinionId: "o", blockIds: ast.blocks.map(({ id }) => id) },
    ],
  });
  if (Result.isError(result)) {
    throw result.error;
  }
  return result.value;
};

const annotate = (
  ast: DocumentAst,
  occurrences: readonly UsCitationOccurrence[],
  budget?: CitationWorkBudget,
): DocumentAst => {
  const annotated = annotateUsCitations(
    ast,
    occurrences,
    budget ?? { limit: Number.POSITIVE_INFINITY, spent: 0 },
  );
  if (Result.isError(annotated)) {
    throw annotated.error;
  }
  return annotated.value;
};

const citationsIn = (inlines: readonly Inline[]): Inline[] =>
  inlines.flatMap((inline) => {
    if (inline.type === "citation") {
      return [inline, ...citationsIn(inline.children)];
    }
    return hasInlineChildren(inline) ? citationsIn(inline.children) : [];
  });

const textRuns = (ast: DocumentAst) =>
  ast.blocks.map((block) => [
    block.id,
    block.anchorId,
    block.type === "paragraph" ? plainTextOf(block.inlines) : "",
  ]);

const SAMPLES = [
  "Brown v. Board of Education, 347 U.S. 483, 74 S. Ct. 686, 98 L. Ed. 873 (1954). Id. at 495.",
  "In Plessy v. Ferguson, 163 U. S. 537, 540, the Court erred. Plessy v. Ferguson, supra, at 544.",
  "See 87 A. 2d 862. The Chancellor (see note 10, infra) agreed. Id., at 865; 28 U.S.C. § 1253.",
  "Compare 347 U.S. 483, with 163 U.S. 537. 347 U.S., at 495–97 & n. 12.",
];

const EMPHASIS = ["italic", "bold", "underline"] as const;

const styledPiece = (
  text: string,
  style: "plain" | "link" | (typeof EMPHASIS)[number],
): Inline => {
  const leaf: Inline = { type: "text", text };
  switch (style) {
    case "plain":
      return leaf;
    case "link":
      return { type: "link", href: "https://court.test/", children: [leaf] };
    case "italic":
    case "bold":
    case "underline":
      return { type: style, children: [leaf] };
  }
};

/**
 * The same characters cut at arbitrary points, each piece set in an
 * arbitrary style and page anchors dropped between them.
 */
const segmented = (text: string) =>
  fc
    .uniqueArray(fc.integer({ min: 1, max: text.length - 1 }), { maxLength: 8 })
    .chain((cuts) => {
      const bounds = [
        0,
        ...cuts.toSorted((left, right) => left - right),
        text.length,
      ];
      const pieces = bounds
        .slice(1)
        .map((end, index) => text.slice(bounds[index], end));
      return fc
        .tuple(
          fc.array(fc.constantFrom("plain", "link", ...EMPHASIS), {
            minLength: pieces.length,
            maxLength: pieces.length,
          }),
          fc.array(fc.boolean(), {
            minLength: pieces.length,
            maxLength: pieces.length,
          }),
        )
        .map(([styles, anchors]): Inline[] =>
          pieces.flatMap((piece, index): Inline[] => {
            const styled = styledPiece(piece, styles[index] ?? "plain");
            return anchors[index]
              ? [{ type: "page-anchor", label: String(index) }, styled]
              : [styled];
          }),
        );
    });

const sample = fc
  .constantFrom(...SAMPLES)
  .chain((text) => segmented(text).map((inlines) => ({ text, inlines })));

const placeless = ({
  blockId: _blockId,
  ...occurrence
}: UsCitationOccurrence) => occurrence;

describe("annotation (properties)", () => {
  test("styling and page anchors change no offset and no target", () => {
    fc.assert(
      fc.property(sample, ({ inlines, text }) => {
        const plain = extract(
          documentOf([paragraph("p", [{ type: "text", text }])]),
        );
        const styled = extract(documentOf([paragraph("p", inlines)]));
        expect(styled.occurrences.map(placeless)).toEqual(
          plain.occurrences.map(placeless),
        );
      }),
      config(300),
    );
  });

  test("keeps every character, block ID and anchor, and is a fixed point", () => {
    fc.assert(
      fc.property(sample, ({ inlines }) => {
        const ast = documentOf([paragraph("p", inlines)]);
        const { documentAst: annotated, occurrences } = extract(ast);
        if (annotated === undefined) {
          throw new Error("A document read with its AST returns it");
        }
        expect(textRuns(annotated)).toEqual(textRuns(ast));
        expect(isDocumentAst(annotated)).toBe(true);
        expect(annotate(annotated, occurrences)).toEqual(annotated);
        expect(extract(annotated).occurrences).toEqual(occurrences);
      }),
      config(300),
    );
  });

  test("every occurrence becomes one wrapper whose cite is its text", () => {
    fc.assert(
      fc.property(sample, ({ inlines, text }) => {
        const { documentAst: annotated, occurrences } = extract(
          documentOf([paragraph("p", inlines)]),
        );
        const block = annotated?.blocks.at(0);
        const wrappers =
          block?.type === "paragraph" ? citationsIn(block.inlines) : [];
        expect(
          wrappers.map((wrapper) =>
            wrapper.type === "citation"
              ? [wrapper.cite, plainTextOf(wrapper.children), wrapper.target]
              : null,
          ),
        ).toEqual(
          occurrences.map(({ end, start, target }) => [
            text.slice(start, end),
            text.slice(start, end),
            target,
          ]),
        );
      }),
      config(300),
    );
  });
});

/** Whatever follows a reference, however long, in pin-like characters. */
const pinLikeTail = fc
  .array(
    fc.constantFrom(
      "495",
      "*3",
      "–",
      "-",
      "97",
      ", ",
      " ",
      "&",
      " and ",
      "n.",
      "nn.",
      "¶",
      "¶¶",
      "12",
      "at ",
    ),
    { maxLength: 40 },
  )
  .map((pieces) => pieces.join(""));

describe("pins (properties)", () => {
  test("any pin the scanner reads fits the pin schema", () => {
    fc.assert(
      fc.property(pinLikeTail, pinLikeTail, (afterFull, afterId) => {
        const { documentAst: annotated } = extract(
          documentOf([
            paragraph("p", [
              {
                type: "text",
                text: `347 U.S. 483, ${afterFull}. Id. at ${afterId}.`,
              },
            ]),
          ]),
        );
        expect(isDocumentAst(annotated)).toBe(true);
      }),
      config(500),
    );
  });
});

describe("annotation work", () => {
  /** The work one annotation of `times` repetitions of `unit` spends. */
  const workOf = (unit: Inline[], times: number): number => {
    const ast = documentOf([
      paragraph("p", Array.from({ length: times }, () => unit).flat()),
    ]);
    const { occurrences } = extract(ast);
    const budget = { limit: Number.POSITIVE_INFINITY, spent: 0 };
    annotate(ast, occurrences, budget);
    return budget.spent;
  };

  const units: Record<string, Inline[]> = {
    "one text node per reference": [
      { type: "text", text: "Brown v. Board, 347 U.S. 483. " },
    ],
    "references split by emphasis and anchors": [
      { type: "text", text: "Brown v. Board, 347 " },
      { type: "page-anchor", label: "5" },
      { type: "italic", children: [{ type: "text", text: "U.S. 483" }] },
      { type: "text", text: ". " },
      {
        type: "citation",
        cite: "x",
        href: "/x",
        children: [{ type: "text", text: "Id., " }],
      },
      { type: "text", text: "at 5. " },
    ],
  };

  test("grows linearly with the references in a run", () => {
    for (const [name, unit] of Object.entries(units)) {
      const once = workOf(unit, 300);
      const twice = workOf(unit, 600);
      expect({ name, linear: twice <= 2 * once + 16 }).toEqual({
        name,
        linear: true,
      });
    }
  });

  test("one paragraph of references long enough to be expensive stays cheap", () => {
    const [unit] = Object.values(units);
    expect(workOf(unit ?? [], 3200)).toBeLessThan(20 * 3200);
  });
});

describe("existing wrappers", () => {
  const annotateFirst = (inlines: Inline[]) => {
    const block = extract(
      documentOf([paragraph("p", inlines)]),
    ).documentAst?.blocks.at(0);
    return block?.type === "paragraph" ? block.inlines : [];
  };

  test("pieces a publisher split one reference into coalesce, keeping their shared link", () => {
    const href = "/citations/?q=87%20A.2d%20862";
    const inlines = annotateFirst([
      {
        type: "citation",
        cite: "87 A.2d 862",
        href,
        children: [{ type: "text", text: "87 A. 2d 862" }],
      },
      { type: "text", text: ". " },
      {
        type: "italic",
        children: [
          {
            type: "citation",
            cite: "87 A.2d 862",
            href,
            children: [{ type: "text", text: "Id., " }],
          },
        ],
      },
      {
        type: "citation",
        cite: "87 A.2d 862",
        href,
        children: [{ type: "text", text: "at 865" }],
      },
      { type: "text", text: "." },
    ]);
    expect(inlines.at(2)).toEqual({
      type: "citation",
      cite: "Id., at 865",
      href,
      children: [
        { type: "italic", children: [{ type: "text", text: "Id., " }] },
        { type: "text", text: "at 865" },
      ],
      target: {
        status: "identified",
        identifiers: [{ type: "reporter-citation", value: "87 A.2d 862" }],
      },
      pin: {
        raw: "865",
        parts: [{ kind: "page", start: "865" }],
        reporter: { type: "reporter-citation", value: "87 A.2d 862" },
      },
    });
    expect(citationsIn(inlines)).toHaveLength(2);
  });

  test("wrappers that disagree on a link leave the reference unlinked", () => {
    const [wrapper] = citationsIn(
      annotateFirst([
        {
          type: "citation",
          cite: "347",
          href: "/a",
          children: [{ type: "text", text: "347 U.S. " }],
        },
        {
          type: "citation",
          cite: "483",
          href: "/b",
          children: [{ type: "text", text: "483" }],
        },
      ]),
    );
    expect(
      wrapper?.type === "citation" ? [wrapper.cite, wrapper.href] : null,
    ).toEqual(["347 U.S. 483", undefined]);
  });

  test("a wrapper crossing no reference stays, without a stale target", () => {
    const statute: Inline = {
      type: "citation",
      cite: "28 U.S.C. § 1253",
      href: "/statute",
      children: [{ type: "text", text: "28 U.S.C. § 1253" }],
      target: { status: "unresolved", reason: "missing-antecedent" },
    };
    expect(annotateFirst([statute])).toEqual([
      {
        type: "citation",
        cite: "28 U.S.C. § 1253",
        href: "/statute",
        children: [{ type: "text", text: "28 U.S.C. § 1253" }],
      },
    ]);
  });

  test("a reference inside one emphasis is wrapped inside it", () => {
    expect(
      annotateFirst([
        { type: "text", text: "See " },
        { type: "italic", children: [{ type: "text", text: "347 U.S. 483" }] },
      ]).at(1),
    ).toEqual({
      type: "italic",
      children: [
        expect.objectContaining({
          type: "citation",
          cite: "347 U.S. 483",
          children: [{ type: "text", text: "347 U.S. 483" }],
        }),
      ],
    });
  });

  test("a page anchor on a reference's edge stays outside it", () => {
    const before: Inline = { type: "page-anchor", label: "484" };
    const after: Inline = { type: "page-anchor", label: "485" };
    expect(
      annotateFirst([
        { type: "text", text: "See " },
        before,
        { type: "text", text: "347 U.S. 483" },
        after,
        { type: "text", text: "." },
      ]),
    ).toEqual([
      { type: "text", text: "See " },
      before,
      expect.objectContaining({
        type: "citation",
        children: [{ type: "text", text: "347 U.S. 483" }],
      }),
      after,
      { type: "text", text: "." },
    ]);
  });

  test("a table cell is annotated in place", () => {
    const table: Block = {
      id: "t",
      anchorId: "t",
      type: "table",
      rows: [
        [
          {
            inlines: [{ type: "text", text: "Cited: 347 U.S. 483" }],
            plainText: "Cited: 347 U.S. 483",
          },
        ],
      ],
      plainText: "Cited: 347 U.S. 483",
    };
    const annotated = extract(documentOf([table])).documentAst?.blocks.at(0);
    expect(
      annotated?.type === "table" ? annotated.rows[0]?.[0]?.inlines : null,
    ).toEqual([
      { type: "text", text: "Cited: " },
      expect.objectContaining({ type: "citation", cite: "347 U.S. 483" }),
    ]);
  });
});
