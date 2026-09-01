import { TaggedError } from "better-result";

import type { Block, DocumentAst } from "@stll/legal-ast/document-ast";

/**
 * Passage chunking for the corpus search projection.
 *
 * Legal relevance lives at passage level: BM25 over a whole judgment dilutes
 * the one paragraph that answers the query, and a long document's term
 * frequencies drown a short, precisely-on-point one. Splitting a document into
 * contiguous passages restores that signal and gives every hit a deep link,
 * because the AST's block `anchorId`s are the same anchors the reader scrolls
 * to.
 *
 * The module is pure: it takes a parsed AST (and the plain-text fallback for
 * rows whose AST never parsed) and returns ordered passages. No I/O, no
 * tokenizer dependency — size is estimated from character count, which is
 * accurate enough to hit a passage-size band and costs nothing.
 *
 * Two rules keep the output faithful to the source:
 *
 * - A block is never split. Concatenating every passage's text reproduces the
 *   document exactly, so no sentence is lost and none is indexed twice
 *   (`chunking.test.ts` asserts this as an equality, not a spot check). A
 *   single oversized block therefore becomes an oversized passage rather than
 *   being cut mid-sentence.
 * - A heading is never a passage of its own; it opens the passage that carries
 *   the section it introduces, and a trailing heading with nothing under it
 *   joins the passage before it (the sole exception is a document that is
 *   nothing but headings, where they are the only content there is).
 *   Continuation passages of a long section do not
 *   repeat the heading text — repeating it would index the same words N times
 *   and skew their document frequency. They carry `headingPath` instead, which
 *   the index maps as an explicitly targetable field (not a default search
 *   field: it repeats per passage, so a free-text match on a boilerplate
 *   heading would return the whole section at once). A heading's own words
 *   stay searchable through the `text` of the passage it opens.
 */

/** One contiguous run of blocks, indexed as its own search document. */
export type CorpusChunk = {
  /** 0-based position within the document; dense, gap-free. */
  seq: number;
  /** Concatenated `plainText` of the member blocks, in document order. */
  text: string;
  /** First member block's stable deep-link anchor; null on the text fallback. */
  anchorId: string | null;
  /** Heading texts from the document root down to this passage's section. */
  headingPath: string[];
};

/**
 * Rough characters-per-token for European legal prose. Only used to express
 * the passage-size band in characters; a real tokenizer would buy accuracy we
 * have no use for and a dependency we would have to keep in sync with the
 * engine's.
 */
const CHARS_PER_TOKEN = 4;

/** Upper edge of the target band (~400 tokens). A passage stops here. */
const CHUNK_TARGET_CHARS = 400 * CHARS_PER_TOKEN;

/**
 * Lower edge of the target band (~250 tokens). A heading closes the passage in
 * progress only once it holds at least this much: otherwise a document of many
 * short sections would emit a passage per heading, each too small to score.
 */
const CHUNK_MIN_CHARS = 250 * CHARS_PER_TOKEN;

/** Block separator. Also what the fallback splits paragraphs on. */
const BLOCK_SEPARATOR = "\n\n";

/**
 * Structural ceilings for one document's chunking work: the chunker runs
 * synchronously, so per-document cost must be bounded up front. A document
 * past either ceiling throws `ChunkBudgetError`, which the indexer's
 * per-row isolation records as a failed index job naming the row, and its
 * batch-mates still commit. The ceilings are far above any legitimate
 * decision or statute (the longest real judgments run to a few hundred
 * thousand characters and a few thousand blocks).
 */
const MAX_CHUNK_INPUT_CHARS = 30_000_000;
const MAX_CHUNK_BLOCKS = 400_000;

/**
 * Heading ancestry deeper than this is a malformed AST (real documents
 * nest a handful of levels). The stack is clamped rather than thrown on:
 * ancestry is a search label, so dropping the shallowest entries degrades
 * a path nobody could read anyway, while a throw would fail a document
 * whose text is perfectly indexable. The clamp also bounds the per-block
 * cost of materializing the path, which is what makes an ever-growing
 * stack quadratic.
 */
const MAX_HEADING_DEPTH = 64;

/** A document exceeded the chunker's structural ceilings. */
export class ChunkBudgetError extends TaggedError("ChunkBudgetError")<{
  message: string;
}> {}

const PARAGRAPH_BREAK = /\n[ \t]*\n/u;

const isBlank = (text: string): boolean => text.trim().length === 0;

type OpenChunk = {
  texts: string[];
  chars: number;
  /** Whether anything other than headings has landed in this passage yet. */
  hasBody: boolean;
  anchorId: string | null;
  headingPath: string[];
};

const emptyChunk = (): OpenChunk => ({
  texts: [],
  chars: 0,
  hasBody: false,
  anchorId: null,
  headingPath: [],
});

/**
 * Accumulates blocks into passages. Kept as a small closure rather than a
 * class so the two entry points (AST, plain-text fallback) share the sizing
 * rule without either owning it.
 */
const createChunkAccumulator = () => {
  const chunks: CorpusChunk[] = [];
  let open = emptyChunk();

  const flush = (): void => {
    if (open.texts.length === 0) {
      return;
    }
    chunks.push({
      seq: chunks.length,
      text: open.texts.join(BLOCK_SEPARATOR),
      anchorId: open.anchorId,
      headingPath: open.headingPath,
    });
    open = emptyChunk();
  };

  type AddOptions = {
    text: string;
    anchorId: string | null;
    headingPath: string[];
    /** Headings open a passage; they never close one, and never stand alone. */
    isHeading: boolean;
  };

  const add = ({
    text,
    anchorId,
    headingPath,
    isHeading,
  }: AddOptions): void => {
    // Both boundary rules require the passage in progress to hold body text.
    // A run of headings with nothing under it yet is not a passage — closing
    // there would emit a heading-only document that can match a query and then
    // show the reader no content.
    if (isHeading) {
      // Align the passage boundary to the section boundary, but only once the
      // passage in progress is worth emitting on its own.
      if (open.hasBody && open.chars >= CHUNK_MIN_CHARS) {
        flush();
      }
    } else if (open.hasBody && open.chars + text.length > CHUNK_TARGET_CHARS) {
      // Closing before the block that would overflow keeps passages inside the
      // band; a block that exceeds the band on its own lands in an empty
      // passage and stays whole.
      flush();
    }

    if (open.texts.length === 0) {
      open.anchorId = anchorId;
    }
    if (open.texts.length === 0 || isHeading) {
      // The passage is labelled with the deepest section it opens: a heading
      // that joins a passage still in progress moves the label onto the
      // section that most of the passage's text will belong to.
      open.headingPath = headingPath;
    }
    open.texts.push(text);
    open.chars += text.length;
    open.hasBody ||= !isHeading;
  };

  /**
   * Close the document. A trailing run of headings (a section header with
   * nothing under it, or a document that is nothing but headings) would
   * otherwise flush as a body-less passage: a result that matches a query and
   * then shows the reader no content.
   *
   * It cannot simply be dropped either — that would lose text. So it joins the
   * previous passage, which is where a reader would look for it anyway. A
   * document with no body at all has no previous passage to join, and its
   * headings are the only content it has; that one is emitted, because the
   * alternative is indexing nothing.
   */
  const finish = (): CorpusChunk[] => {
    const previous = chunks.at(-1);
    if (open.texts.length > 0 && !open.hasBody && previous !== undefined) {
      previous.text = [previous.text, ...open.texts].join(BLOCK_SEPARATOR);
      open = emptyChunk();
    }
    flush();
    return chunks;
  };

  return { add, finish };
};

/** Heading ancestry as a stack; a heading pops every sibling-or-deeper entry. */
const createHeadingStack = () => {
  const stack: { level: number; text: string }[] = [];

  const push = (level: number, text: string): void => {
    // Terminate on the stack, not on the level. Each iteration removes an
    // entry, so bounding on length cannot spin even if this helper is called
    // with an object that bypassed the persisted AST schema.
    while (stack.length > 0 && (stack.at(-1)?.level ?? 0) >= level) {
      stack.pop();
    }
    stack.push({ level, text });
    if (stack.length > MAX_HEADING_DEPTH) {
      stack.splice(0, stack.length - MAX_HEADING_DEPTH);
    }
  };

  const path = (): string[] => stack.map((entry) => entry.text);

  return { push, path };
};

/**
 * Runtime check that a persisted block carries what the chunker reads.
 *
 * `DocumentAst` is persisted to object storage and read back as JSON. Its
 * Valibot-backed guard validates the complete block/source/metadata shape;
 * this local check remains a defensive backstop for callers that construct an
 * object in memory or bypass the parser.
 *
 * Checked with `in` rather than a discriminator: there is no trusted
 * discriminator to read until the shape itself is proven.
 */
const isChunkableBlock = (block: unknown): boolean => {
  if (typeof block !== "object" || block === null) {
    return false;
  }
  if (!("plainText" in block) || typeof block.plainText !== "string") {
    return false;
  }
  if (!("anchorId" in block) || typeof block.anchorId !== "string") {
    return false;
  }
  if (!("type" in block)) {
    return false;
  }
  if (typeof block.type !== "string" || !isChunkableBlockType(block.type)) {
    return false;
  }
  // A heading additionally drives the ancestry stack, which reads `level`.
  return (
    block.type !== "heading" ||
    ("level" in block && typeof block.level === "number")
  );
};

/**
 * Every block kind is chunkable: each carries `plainText` and `anchorId`,
 * and a blank text (an image with no alt) is skipped by the walk. Total
 * over `Block["type"]`, so a new kind cannot silently send the whole
 * document to the unanchored plain-text fallback.
 */
const CHUNKABLE_BLOCK_TYPES = {
  heading: true,
  paragraph: true,
  table: true,
  image: true,
} as const satisfies Record<Block["type"], true>;

const isChunkableBlockType = (type: string): type is Block["type"] =>
  Object.hasOwn(CHUNKABLE_BLOCK_TYPES, type);

const chunkBlocks = (blocks: readonly Block[]): CorpusChunk[] => {
  if (blocks.length > MAX_CHUNK_BLOCKS) {
    throw new ChunkBudgetError({
      message: `Document has ${blocks.length} blocks; ceiling is ${MAX_CHUNK_BLOCKS}`,
    });
  }
  const accumulator = createChunkAccumulator();
  const headings = createHeadingStack();

  // The block-count ceiling alone does not bound the walk: one block can
  // carry an arbitrarily long `plainText`, so total characters are budgeted
  // like the plain-text path's input.
  let totalChars = 0;
  for (const block of blocks) {
    totalChars += block.plainText.length;
    if (totalChars > MAX_CHUNK_INPUT_CHARS) {
      throw new ChunkBudgetError({
        message: `Document text exceeds the ${MAX_CHUNK_INPUT_CHARS}-char ceiling`,
      });
    }
    if (isBlank(block.plainText)) {
      continue;
    }
    const isHeading = block.type === "heading";
    if (isHeading) {
      headings.push(block.level, block.plainText);
    }
    accumulator.add({
      text: block.plainText,
      anchorId: block.anchorId,
      headingPath: headings.path(),
      isHeading,
    });
  }

  return accumulator.finish();
};

/**
 * Fallback for rows that have text but no usable AST (a source we cannot parse
 * yet, or a document ingested before its parser landed). Blank lines are the
 * only structure such text carries, so they stand in for block boundaries;
 * without anchors these passages cannot deep-link, and `anchorId` stays null
 * rather than pointing somewhere approximate.
 */
const chunkPlainText = (text: string): CorpusChunk[] => {
  if (text.length > MAX_CHUNK_INPUT_CHARS) {
    throw new ChunkBudgetError({
      message: `Fallback text is ${text.length} chars; ceiling is ${MAX_CHUNK_INPUT_CHARS}`,
    });
  }
  const accumulator = createChunkAccumulator();
  for (const paragraph of text.split(PARAGRAPH_BREAK)) {
    if (isBlank(paragraph)) {
      continue;
    }
    accumulator.add({
      text: paragraph,
      anchorId: null,
      headingPath: [],
      isHeading: false,
    });
  }
  return accumulator.finish();
};

export type ChunkDocumentInput = {
  /**
   * Parsed AST when the document has one. `null`, a blockless AST, or one
   * whose blocks do not hold up at runtime all fall through to the plain-text
   * path — the type is a claim about persisted JSON, not a guarantee.
   */
  ast: DocumentAst | null;
  /** Canonical plain text; the fallback source and the empty-document guard. */
  fallbackText: string;
};

/**
 * Split one corpus document into ordered passages.
 *
 * Always returns at least one passage. A document with neither blocks nor text
 * still has indexable metadata (case number, court, date), and emitting
 * nothing would drop it out of filtered searches entirely while the indexer
 * still recorded it as indexed.
 */
export const chunkDocument = ({
  ast,
  fallbackText,
}: ChunkDocumentInput): CorpusChunk[] => {
  // The ceiling applies before the conformance scan: `every` is linear too,
  // so a many-million-block junk array must be rejected before any walk.
  if (ast !== null && ast.blocks.length > MAX_CHUNK_BLOCKS) {
    throw new ChunkBudgetError({
      message: `Document has ${ast.blocks.length} blocks; ceiling is ${MAX_CHUNK_BLOCKS}`,
    });
  }
  // A single non-conforming block condemns the whole AST rather than being
  // skipped: the canonical text is complete, so degrading to it keeps every
  // word, while dropping bad blocks would silently lose whatever they held.
  // The structure is what is untrustworthy here, not the content.
  const fromAst =
    ast?.blocks.every(isChunkableBlock) === true ? chunkBlocks(ast.blocks) : [];
  if (fromAst.length > 0) {
    return fromAst;
  }
  // An AST that parsed but carries no readable block is as unusable as none
  // at all, so it degrades to the same text path rather than to one empty
  // passage.
  const fromText = chunkPlainText(fallbackText);
  if (fromText.length > 0) {
    return fromText;
  }
  return [{ seq: 0, text: "", anchorId: null, headingPath: [] }];
};

/** Joins a heading path into the single string the index stores. */
export const formatHeadingPath = (headingPath: readonly string[]): string =>
  headingPath.join(" > ");
