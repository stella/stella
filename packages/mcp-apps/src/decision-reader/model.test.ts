import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import type { ParagraphBlock } from "@stll/legal-ast/document-ast";
import { assertProperty } from "@stll/property-testing";

import {
  appendReaderPage,
  createReaderPager,
  parseOpenDecision,
  parseReaderPage,
  resolveReaderRange,
} from "./model";
import type { ReaderPage, ReaderPager } from "./model";

const metadata = {
  decisionId: "00000000-0000-4000-8000-000000000001",
  caseNumber: "1 C 1/2026",
  caseNumberType: "case-number",
  courtAbbreviation: null,
  courtTier: "other",
  language: "cs",
  court: "Court",
  country: "CZ",
  date: null,
  ecli: null,
  appUrl: "https://stella.example/decisions/1",
} satisfies ReaderPage["metadata"];
const paragraph = (number: number, text = `Paragraph ${number}`) =>
  ({
    id: `block-${number}`,
    anchorId: `publisher-${number}`,
    type: "paragraph",
    number,
    inlines: [{ type: "text", text }],
    plainText: text,
  }) satisfies ParagraphBlock;
const page = (
  content: Partial<
    Extract<ReaderPage["content"], { status: "available" }>
  > = {},
): ReaderPage => ({
  metadata,
  content: {
    status: "available",
    phase: "blocks",
    items: [],
    blockFragments: [],
    citationAnchors: [],
    provisionAnchors: [],
    nextCursor: null,
    limit: 60_000,
    ...content,
  },
});
const accept = (state: ReaderPager, next: ReaderPage) => {
  const result = appendReaderPage({
    state,
    page: next,
    cursor: state.nextCursor,
  });
  expect(result.status).toBe("accepted");
  if (result.status === "invalid") {
    throw new TypeError(result.reason);
  }
  return result.state;
};

describe("MCP decision reader paging", () => {
  test("MCP reader fragments preserve blocks across every JSON split", () => {
    assertProperty(
      "MCP reader fragments preserve blocks across every JSON split",
      fc.property(fc.string({ maxLength: 80 }), fc.nat(), (text, offset) => {
        const block = paragraph(48, text);
        const json = JSON.stringify(block);
        const split = 1 + (offset % (json.length - 1));
        const fragment = { blockId: block.id, totalChars: json.length };
        const first = accept(
          createReaderPager(metadata),
          page({
            blockFragments: [
              { ...fragment, offset: 0, json: json.slice(0, split) },
            ],
            nextCursor: "continuation",
          }),
        );
        expect(first.blocks).toEqual([]);
        expect(first.complete).toBe(false);
        const second = accept(
          first,
          page({
            blockFragments: [
              { ...fragment, offset: split, json: json.slice(split) },
            ],
          }),
        );
        expect(second.blocks).toEqual([block]);
        expect(second.pendingFragment).toBeNull();
        expect(second.complete).toBe(true);
      }),
    );
  });
  test("anchor-only pages continue after blocks and preserve provision objects", () => {
    let state = accept(
      createReaderPager(metadata),
      page({ items: [paragraph(48)], nextCursor: "citations" }),
    );
    state = accept(
      state,
      page({
        phase: "citations",
        citationAnchors: [
          {
            pieceId: "block-48",
            start: 0,
            end: 3,
            citationId: "citation-1",
            decisionId: metadata.decisionId,
            appUrl: null,
          },
        ],
        nextCursor: "provisions",
      }),
    );
    const provision = {
      document_id: metadata.decisionId,
      anchor: "par-1",
      cited_anchor: "par-1-1",
    };
    state = accept(
      state,
      page({
        phase: "provisions",
        provisionAnchors: [
          { pieceId: "block-48", start: 0, end: 3, provision, appUrl: null },
        ],
      }),
    );
    expect(state.blocks).toEqual([paragraph(48)]);
    expect(state.citationAnchors).toHaveLength(1);
    expect(state.provisionAnchors.at(0)?.provision).toEqual(provision);
    expect(state.complete).toBe(true);
  });
  test("open range links survive pages whose metadata URL has no fragment", () => {
    const rangedMetadata = {
      ...metadata,
      appUrl: `${metadata.appUrl}#par=48-49`,
    };
    const state = accept(
      createReaderPager(rangedMetadata),
      page({ items: [paragraph(48)] }),
    );
    expect(state.metadata.appUrl).toBe(rangedMetadata.appUrl);
  });
  test("target ranges resolve only after their court paragraphs have arrived", () => {
    const initial = accept(
      createReaderPager(metadata),
      page({ items: [paragraph(48)], nextCursor: "next" }),
    );
    expect(resolveReaderRange(initial, { from: 48, to: 49 })).toEqual({
      type: "not-found",
      missing: [49],
    });
    const complete = accept(initial, page({ items: [paragraph(49)] }));
    expect(resolveReaderRange(complete, { from: 48, to: 49 })).toEqual({
      type: "found",
      anchorIds: ["publisher-48", "publisher-49"],
      firstAnchorId: "publisher-48",
    });
  });
  test("invalid continuations leave the prior reader state intact", () => {
    const initial = accept(
      createReaderPager(metadata),
      page({ items: [paragraph(48)], nextCursor: "next" }),
    );
    const serialized = JSON.stringify(initial);
    const continuations = [
      page({ nextCursor: "next" }),
      page({ nextCursor: "" }),
      page({ items: [paragraph(48)] }),
      { ...page(), metadata: { ...metadata, court: "Other court" } },
      page({ phase: "citations", items: [paragraph(49)] }),
      page({
        blockFragments: [
          { blockId: "block-49", offset: 1, totalChars: 3, json: "{}" },
        ],
      }),
      page({
        blockFragments: [
          { blockId: "block-49", offset: 0, totalChars: 3, json: "{" },
        ],
      }),
      page({
        blockFragments: [
          { blockId: "block-49", offset: 0, totalChars: 2, json: "{}" },
        ],
      }),
    ];
    for (const next of continuations) {
      expect(
        appendReaderPage({ state: initial, page: next, cursor: "next" }).status,
      ).toBe("invalid");
      expect(JSON.stringify(initial)).toBe(serialized);
    }
    expect(
      appendReaderPage({ state: initial, page: page(), cursor: "wrong" })
        .status,
    ).toBe("invalid");
  });
  test("fragment gaps, identity changes and phase transitions are rejected", () => {
    const block = paragraph(48);
    const json = JSON.stringify(block);
    const first = accept(
      createReaderPager(metadata),
      page({
        blockFragments: [
          {
            blockId: block.id,
            offset: 0,
            totalChars: json.length,
            json: json.slice(0, 10),
          },
        ],
        nextCursor: "next",
      }),
    );
    for (const next of [
      page({ items: [paragraph(49)] }),
      page({ phase: "citations", nextCursor: "other" }),
      page({
        blockFragments: [
          {
            blockId: block.id,
            offset: 11,
            totalChars: json.length,
            json: json.slice(10),
          },
        ],
      }),
      page({
        blockFragments: [
          {
            blockId: "other",
            offset: 10,
            totalChars: json.length,
            json: json.slice(10),
          },
        ],
      }),
    ]) {
      expect(
        appendReaderPage({ state: first, page: next, cursor: "next" }).status,
      ).toBe("invalid");
    }
  });
  test("withheld and unavailable results discard previously loaded body text", () => {
    const initial = accept(
      createReaderPager(metadata),
      page({ items: [paragraph(48)], nextCursor: "next" }),
    );
    const withheldReason = {
      code: "source_licence",
      message: "Open in stella",
    } as const;
    const withheld = accept(initial, {
      metadata,
      content: { status: "withheld", withheldReason },
    });
    expect(withheld.status).toBe("withheld");
    expect(withheld.blocks).toEqual([]);
    expect(withheld.complete).toBe(true);
    if (withheld.status === "withheld") {
      expect(withheld.withheldReason).toEqual(withheldReason);
    }
    const unavailable = accept(initial, {
      metadata,
      content: { status: "unavailable" },
    });
    expect(unavailable.status).toBe("unavailable");
    expect(unavailable.blocks).toEqual([]);
  });
  test("generated tool schemas validate full producer-shaped payloads", () => {
    const next = page({ items: [paragraph(48)] });
    expect(parseReaderPage(next)).toEqual(next);
    expect(
      parseReaderPage({ ...next, metadata: { ...metadata, decisionId: 1 } }),
    ).toBeUndefined();
    expect(
      parseReaderPage({ metadata, content: { status: "available" } }),
    ).toBeUndefined();
    expect(
      parseOpenDecision({
        status: "withheld",
        metadata,
        withheldReason: { code: "source_licence", message: "Open in stella" },
      }),
    ).toBeDefined();
  });
});
