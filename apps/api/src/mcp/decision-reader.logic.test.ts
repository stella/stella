import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import type { DocumentAst, ParagraphBlock } from "@stll/legal-ast/document-ast";

import {
  READER_PAGE_CONTENT_CHARS,
  openDecisionArgs,
} from "./decision-reader-contract";
import {
  decodeReaderCursor,
  encodeReaderCursor,
  packReaderPage,
  readerVersion,
  selectReaderWindow,
} from "./decision-reader.logic";

const astOf = (blocks: ParagraphBlock[]) =>
  ({
    version: 1,
    source: { system: "", documentId: "", webUrl: "", printUrl: "" },
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
  }) satisfies DocumentAst;
const paragraph = (number: number, text = `Court paragraph ${number}`) =>
  ({
    id: `block-${number}`,
    anchorId: `publisher-${number}`,
    type: "paragraph",
    number,
    inlines: [{ type: "text", text }],
    plainText: text,
  }) satisfies ParagraphBlock;

describe("decision reader paragraph windows", () => {
  test("court numbers resolve to publisher anchors, never block ordinals", () => {
    const blocks = [paragraph(48), paragraph(49), paragraph(50)];
    expect(
      selectReaderWindow({
        ast: astOf(blocks),
        paragraphs: { from: 48, to: 50 },
      }),
    ).toEqual({
      status: "selected",
      truncated: false,
      window: blocks.map((block) => ({
        number: block.number,
        anchorId: block.anchorId,
        text: block.plainText,
      })),
    });
    expect(
      selectReaderWindow({
        ast: astOf(blocks),
        paragraphs: { from: 1, to: 1 },
      }),
    ).toEqual({ status: "not_found", missing: [1] });
    expect(
      selectReaderWindow({
        ast: astOf([paragraph(48), paragraph(50)]),
        paragraphs: { from: 48, to: 50 },
      }),
    ).toEqual({ status: "not_found", missing: [49] });
    expect(
      selectReaderWindow({
        ast: astOf([paragraph(48), paragraph(48)]),
        paragraphs: { from: 48, to: 49 },
      }),
    ).toEqual({ status: "not_found", missing: [49] });
  });
  test("explicit windows refuse oversize selections and default windows mark truncation", () => {
    expect(
      selectReaderWindow({
        ast: astOf([paragraph(48, "a".repeat(8001))]),
        paragraphs: { from: 48, to: 48 },
      }),
    ).toEqual({ status: "too_large" });
    const selected = selectReaderWindow({
      ast: astOf([paragraph(48, "a".repeat(8001))]),
      paragraphs: undefined,
    });
    expect(selected.status).toBe("selected");
    if (selected.status === "selected") {
      expect(selected.truncated).toBe(true);
      expect(selected.window.at(0)?.text.length).toBe(8000);
    }
  });
  test("the advertised schema parses the same court range input", () => {
    const id = "af6c7d89-41ab-42ba-814e-b657703584eb";
    expect(
      v.safeParse(openDecisionArgs, { decision_id: id, paragraphs: "48-53" })
        .success,
    ).toBe(true);
    expect(
      v.safeParse(openDecisionArgs, { decision_id: id, paragraphs: "48–53" })
        .success,
    ).toBe(true);
    expect(
      v.safeParse(openDecisionArgs, { decision_id: id, paragraphs: null })
        .success,
    ).toBe(true);
  });
  test("default window bounds preserve Unicode code points without exceeding the budget", () => {
    const selected = selectReaderWindow({
      ast: astOf([paragraph(48, `${"a".repeat(7999)}😀`)]),
      paragraphs: undefined,
    });
    if (selected.status !== "selected") {
      throw new Error("Expected a bounded default window");
    }
    expect(selected.truncated).toBe(true);
    expect(selected.window.at(0)?.text).toBe("a".repeat(7999));
  });
});
describe("decision reader bounded pages", () => {
  test("pagination round-trips the whole decision exactly once with JSON escaping counted", () => {
    const blocks = Array.from({ length: 160 }, (_, index) =>
      paragraph(index + 1, `${index} ${'"\\\n😀'.repeat(600)}`),
    );
    expect(JSON.stringify(blocks).length).toBeGreaterThan(
      READER_PAGE_CONTENT_CHARS,
    );
    let offset = 0;
    const read: ParagraphBlock[] = [];
    const offsets = new Set<number>();
    for (;;) {
      expect(offsets.has(offset)).toBe(false);
      offsets.add(offset);
      const page = packReaderPage(blocks, offset);
      expect(page.status).toBe("packed");
      if (page.status !== "packed") {
        throw new Error("Expected a packed reader page");
      }
      expect(JSON.stringify(page.items).length).toBeLessThanOrEqual(
        READER_PAGE_CONTENT_CHARS,
      );
      read.push(...page.items);
      if (page.nextOffset === null) {
        break;
      }
      expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset;
    }
    expect(read).toEqual(blocks);
    expect(new Set(read.map((block) => block.id)).size).toBe(blocks.length);
  });
  test("an oversized indivisible block is refused and cannot create a repeating page", () => {
    expect(
      packReaderPage([paragraph(1, "x".repeat(READER_PAGE_CONTENT_CHARS))], 0),
    ).toEqual({ status: "too_large" });
    expect(packReaderPage([paragraph(1)], 2)).toEqual({
      status: "invalid_offset",
    });
    expect(packReaderPage([], 0)).toEqual({
      status: "packed",
      items: [],
      nextOffset: null,
    });
  });
  test("cursor encoding is deterministic and round-trips every phase", () => {
    for (const phase of ["blocks", "citations", "provisions"] as const) {
      const cursor = {
        decisionId: "decision",
        version: readerVersion([paragraph(48)]),
        phase,
        offset: 12,
        blockOffset: 0,
        referenceCursor: "reference",
      };
      expect(encodeReaderCursor(cursor)).toBe(encodeReaderCursor(cursor));
      expect(decodeReaderCursor(encodeReaderCursor(cursor))).toEqual(cursor);
    }
    for (const cursor of [
      "",
      "invalid",
      Buffer.from('[{"phase":"blocks","offset":-1}]').toString("base64url"),
    ]) {
      expect(decodeReaderCursor(cursor)).toBeNull();
    }
    expect(readerVersion([paragraph(48)])).not.toBe(
      readerVersion([paragraph(48, "Changed")]),
    );
  });
});
