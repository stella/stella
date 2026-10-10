import { panic } from "better-result";
import * as v from "valibot";

import type { DecisionParagraphRange } from "@stll/api-contract/decision-paragraph-range";
import type { DocumentAst, Block } from "@stll/legal-ast/document-ast";
import { resolveDecisionParagraphRange } from "@stll/legal-ast/paragraph-range";

import type { readDecisionReaderSource } from "@/api/handlers/case-law/decisions/reader";
import { LIMITS } from "@/api/lib/limits";
import {
  decodePaginationCursor,
  encodePaginationCursor,
} from "@/api/lib/pagination";

import { sha256Base64Url } from "../../../../packages/sha256/src/bun";
import {
  READER_FRAGMENT_CHARS,
  READER_OPEN_TEXT_CHARS,
  READER_OUTLINE_ENTRIES,
  READER_PAGE_CONTENT_CHARS,
} from "./decision-reader-contract";
import { resolveTextWindowBounds } from "./tool-utils";

const cursorSchema = v.strictObject({
  version: v.string(),
  decisionId: v.string(),
  phase: v.picklist(["blocks", "citations", "provisions"]),
  offset: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(LIMITS.decisionReaderCursorOffsetMin),
  ),
  blockOffset: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(LIMITS.decisionReaderCursorOffsetMin),
  ),
  referenceCursor: v.nullable(v.string()),
  /**
   * Digest of the anchor batch an anchor-phase offset indexes into. Anchors
   * change independently of the AST, so a continuation inside one batch must
   * see the same batch; null when the offset starts a batch.
   */
  batchDigest: v.nullable(v.string()),
});
export type ReaderCursor = v.InferOutput<typeof cursorSchema>;
export const decodeReaderCursor = (cursor: string): ReaderCursor | null => {
  const parts = decodePaginationCursor(cursor);
  if (parts?.length !== 1) {
    return null;
  }
  const parsed = v.safeParse(cursorSchema, parts.at(0));
  return parsed.success ? parsed.output : null;
};
export const encodeReaderCursor = (cursor: ReaderCursor) =>
  encodePaginationCursor([cursor]);
export const readerVersion = (blocks: readonly Block[]) =>
  sha256Base64Url(JSON.stringify(blocks));

const anchorBatchDigest = (anchors: readonly unknown[]) =>
  sha256Base64Url(JSON.stringify(anchors));

const DEFAULT_WINDOW_BLOCKS = 3;

type SelectReaderWindowOptions = {
  ast: DocumentAst;
  paragraphs: DecisionParagraphRange | undefined;
};
export const selectReaderWindow = ({
  ast,
  paragraphs,
}: SelectReaderWindowOptions) => {
  const resolved =
    paragraphs === undefined
      ? null
      : resolveDecisionParagraphRange(ast, paragraphs);
  if (resolved?.type === "not-found") {
    return { status: "not_found" as const, missing: resolved.missing };
  }
  const byAnchor = new Map(ast.blocks.map((block) => [block.anchorId, block]));
  const nonEmpty = ast.blocks.filter((block) => block.plainText.length > 0);
  const selected =
    resolved === null
      ? nonEmpty.slice(0, DEFAULT_WINDOW_BLOCKS)
      : resolved.anchorIds.map(
          (anchorId) =>
            byAnchor.get(anchorId) ??
            panic("Resolved paragraph anchor has no block"),
        );
  if (
    paragraphs !== undefined &&
    selected.reduce((count, block) => count + block.plainText.length, 0) >
      READER_OPEN_TEXT_CHARS
  ) {
    return { status: "too_large" as const };
  }
  let remaining: number = READER_OPEN_TEXT_CHARS;
  // The default window also omits whole blocks past its first few.
  let truncated = resolved === null && nonEmpty.length > selected.length;
  const window = selected.flatMap((block) => {
    if (remaining === 0) {
      truncated = true;
      return [];
    }
    const bounds = resolveTextWindowBounds({
      text: block.plainText,
      offset: 0,
      size: remaining,
    });
    const text =
      bounds.end > remaining ? "" : block.plainText.slice(0, bounds.end);
    remaining -= text.length;
    truncated ||= text.length < block.plainText.length;
    return [
      {
        anchorId: block.anchorId,
        number: block.type === "paragraph" ? (block.number ?? null) : null,
        text,
      },
    ];
  });
  return { status: "selected" as const, window, truncated };
};

export const readerOutline = (blocks: readonly Block[]) =>
  blocks
    .flatMap((block) =>
      block.type === "heading"
        ? [
            {
              anchorId: block.anchorId,
              title: block.plainText.slice(0, 80),
              level: block.level,
            },
          ]
        : [],
    )
    .slice(0, READER_OUTLINE_ENTRIES);

/** Pack complete values, accounting for JSON escaping; an indivisible oversized block is an explicit refusal. */
export const packReaderPage = <T>(items: readonly T[], offset: number) => {
  if (offset > items.length) {
    return { status: "invalid_offset" as const };
  }
  const packed: T[] = [];
  let chars = 2;
  for (const item of items.slice(offset)) {
    const size = JSON.stringify(item).length + (packed.length === 0 ? 0 : 1);
    if (chars + size > READER_PAGE_CONTENT_CHARS) {
      if (packed.length === 0) {
        return { status: "too_large" as const };
      }
      break;
    }
    packed.push(item);
    chars += size;
  }
  return {
    status: "packed" as const,
    items: packed,
    nextOffset:
      offset + packed.length < items.length ? offset + packed.length : null,
  };
};

export type ReaderSource = Extract<
  NonNullable<Awaited<ReturnType<typeof readDecisionReaderSource>>>,
  { status: "read" }
>;

type PackReaderBlocksOptions = {
  blocks: readonly Block[];
  offset: number;
  blockOffset: number;
};
const packReaderBlocks = ({
  blocks,
  offset,
  blockOffset,
}: PackReaderBlocksOptions) => {
  const packed = packReaderPage(blocks, offset);
  if (packed.status === "invalid_offset") {
    return packed;
  }
  if (packed.status === "packed" && blockOffset === 0) {
    return {
      status: "packed" as const,
      items: packed.items,
      blockFragments: [],
      nextOffset: packed.nextOffset,
      nextBlockOffset: 0,
    };
  }
  const block = blocks[offset];
  if (block === undefined) {
    return { status: "invalid_offset" as const };
  }
  const json = JSON.stringify(block);
  // Fragments belong only to an oversized block; a cursor cannot skip a normal block's prefix.
  if (
    json.length + 2 <= READER_PAGE_CONTENT_CHARS ||
    blockOffset >= json.length
  ) {
    return { status: "invalid_offset" as const };
  }
  const bounds = resolveTextWindowBounds({
    text: json,
    offset: blockOffset,
    size: READER_FRAGMENT_CHARS,
  });
  if (bounds.start !== blockOffset) {
    return { status: "invalid_offset" as const };
  }
  let nextOffset = bounds.nextOffset === null ? null : offset;
  if (bounds.nextOffset === null && offset + 1 < blocks.length) {
    nextOffset = offset + 1;
  }
  return {
    status: "packed" as const,
    items: [],
    blockFragments: [
      {
        blockId: block.id,
        offset: blockOffset,
        totalChars: json.length,
        json: json.slice(bounds.start, bounds.end),
      },
    ],
    nextOffset,
    nextBlockOffset: bounds.nextOffset ?? 0,
  };
};

type ReaderPhasePageOptions = {
  ast: DocumentAst;
  source: ReaderSource;
  phase: ReaderCursor["phase"];
  offset: number;
  blockOffset: number;
};
const readerPhasePage = ({
  ast,
  source,
  phase,
  offset,
  blockOffset,
}: ReaderPhasePageOptions) => {
  switch (phase) {
    case "blocks": {
      const packed = packReaderBlocks({
        blocks: ast.blocks,
        offset,
        blockOffset,
      });
      if (packed.status !== "packed") {
        return packed;
      }
      return { ...packed, citationAnchors: [], provisionAnchors: [] };
    }
    case "citations": {
      const packed = packReaderPage(source.citationAnchors, offset);
      if (packed.status !== "packed") {
        return packed;
      }
      return {
        status: "packed" as const,
        items: [],
        blockFragments: [],
        citationAnchors: packed.items,
        provisionAnchors: [],
        nextOffset: packed.nextOffset,
        nextBlockOffset: 0,
      };
    }
    case "provisions": {
      const packed = packReaderPage(source.provisionAnchors, offset);
      if (packed.status !== "packed") {
        return packed;
      }
      return {
        status: "packed" as const,
        items: [],
        blockFragments: [],
        citationAnchors: [],
        provisionAnchors: packed.items,
        nextOffset: packed.nextOffset,
        nextBlockOffset: 0,
      };
    }
    default:
      phase satisfies never;
      return panic("Unknown reader phase");
  }
};

type NextReaderCursorOptions = {
  current: ReaderCursor;
  nextOffset: number | null;
  nextBlockOffset: number;
  referenceNextCursor: string | null;
  batchDigest: string | null;
};
const nextReaderCursor = ({
  current,
  nextOffset,
  nextBlockOffset,
  referenceNextCursor,
  batchDigest,
}: NextReaderCursorOptions): ReaderCursor | null => {
  if (nextOffset !== null) {
    return {
      decisionId: current.decisionId,
      version: current.version,
      phase: current.phase,
      offset: nextOffset,
      blockOffset: nextBlockOffset,
      referenceCursor: current.referenceCursor,
      batchDigest,
    };
  }
  if (current.phase !== "blocks" && referenceNextCursor !== null) {
    return {
      decisionId: current.decisionId,
      version: current.version,
      phase: current.phase,
      offset: 0,
      blockOffset: 0,
      referenceCursor: referenceNextCursor,
      batchDigest: null,
    };
  }
  if (current.phase === "provisions") {
    return null;
  }
  return {
    decisionId: current.decisionId,
    version: current.version,
    phase: current.phase === "blocks" ? "citations" : "provisions",
    offset: 0,
    blockOffset: 0,
    referenceCursor: null,
    batchDigest: null,
  };
};

/** Blocks are bound by the cursor version; anchor batches by their digest. */
const anchorBatchDigestOf = (
  source: ReaderSource,
  phase: ReaderCursor["phase"],
): string | null => {
  switch (phase) {
    case "blocks":
      return null;
    case "citations":
      return anchorBatchDigest(source.citationAnchors);
    case "provisions":
      return anchorBatchDigest(source.provisionAnchors);
    default:
      phase satisfies never;
      return panic("Unknown reader phase");
  }
};

type PackReaderSourcePageOptions = {
  ast: DocumentAst;
  source: ReaderSource;
  position: ReaderCursor | null;
};
export const packReaderSourcePage = ({
  ast,
  source,
  position,
}: PackReaderSourcePageOptions) => {
  const version = readerVersion(ast.blocks);
  if (position !== null && position.version !== version) {
    return { status: "conflict" as const };
  }
  const current =
    position ??
    ({
      decisionId: source.decision.id,
      version,
      phase: "blocks",
      offset: 0,
      blockOffset: 0,
      referenceCursor: null,
      batchDigest: null,
    } as const);
  if (current.phase !== "blocks" && current.blockOffset !== 0) {
    return { status: "invalid_offset" as const };
  }
  const batchDigest = anchorBatchDigestOf(source, current.phase);
  if (current.offset > 0 && current.batchDigest !== batchDigest) {
    return { status: "conflict" as const };
  }
  const packed = readerPhasePage({
    ast,
    source,
    phase: current.phase,
    offset: current.offset,
    blockOffset: current.blockOffset,
  });
  if (packed.status !== "packed") {
    return packed;
  }
  const next = nextReaderCursor({
    current,
    nextOffset: packed.nextOffset,
    nextBlockOffset: packed.nextBlockOffset,
    referenceNextCursor: source.referenceNextCursor,
    batchDigest,
  });
  return {
    status: "packed" as const,
    phase: current.phase,
    items: packed.items,
    blockFragments: packed.blockFragments,
    citationAnchors: packed.citationAnchors,
    provisionAnchors: packed.provisionAnchors,
    nextCursor: next === null ? null : encodeReaderCursor(next),
  };
};
