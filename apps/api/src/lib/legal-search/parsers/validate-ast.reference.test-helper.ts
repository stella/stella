// parser-output-unchanged: Non-CourtListener callers omit sourcePolicy; their original default expressions and detectors are retained, with baseline fixture diagnostics locked by validate-ast-defaults.test.ts.
// parser-output-unchanged: Validation work counters are diagnostics only; parsed records are unchanged.
// parser-output-unchanged: the reference text is read from the same elements in the same order; validation diagnostics and stored parser output are unchanged.
/**
 * AST sanity checker.
 *
 * Every parser MUST call `validateAstReference` after producing blocks.
 * It checks for content loss, structural anomalies, and
 * formatting issues. Violations are logged as warnings;
 * in tests, the result can be asserted.
 */

import * as cheerio from "cheerio";
import { type AnyNode, isTag } from "domhandler";

// parser-output-unchanged: imports the document AST from its package owner
import type { Block, Inline } from "@stll/legal-ast/document-ast";

import { visibleHtmlText } from "@/api/handlers/case-law/ingestion/parsers/shared-inlines";
import { markupResidueIn } from "@/api/lib/legal-search/parsers/markup-residue";
import type { MarkupResidue } from "@/api/lib/legal-search/parsers/markup-residue";

// ── Types ──────────────────────────────────────────────────

type Issue = {
  code: string;
  message: string;
  severity: "error" | "warning";
};

type ValidationResult = {
  ok: boolean;
  issues: Issue[];
  stats: {
    originalLength: number;
    astLength: number;
    retainedPct: number;
    blockCount: number;
    missingWords: string[];
    boundaryWhitespaceWords: string[];
    blockTypeCounts: Record<string, number>;
    /** Blocks with suspiciously short text (< 5 chars). */
    tinyBlocks: number;
    /** Blocks with very long text (> 5000 chars). */
    hugeBlocks: number;
    /** Consecutive duplicate plainText blocks. */
    duplicateBlocks: number;
    /** Blocks whose text still carries the source's own markup. */
    markupResidue: BlockMarkupResidue[];
    /**
     * Deterministic work done collecting the source text: subtree text
     * computations, the characters they produced, and ancestor checks. All
     * grow linearly with a flat document; a cache or traversal regression
     * makes them grow faster (characters catch a wrapper's text being
     * recomputed for every child).
     */
    work: {
      textComputations: number;
      textCharacters: number;
      ancestorChecks: number;
    };
  };
};

/** Explicit publisher policy; other sources keep the shared validation semantics. */
type ValidationSourcePolicy = {
  source: "courtlistener";
  projectSourceText: (text: string) => string;
  projectInlineText: (inlines: readonly Inline[]) => string;
  markupResidueIn: (text: string) => MarkupResidue | undefined;
};

type ValidationOptions = {
  minRetainedPct?: number;
  maxMissingWords?: number;
  /** Source words with explicit inline breaks; never used for retention. */
  wordComparisonText?: string;
  sourcePolicy?: ValidationSourcePolicy;
};

/** Source markup found in one block, named by the anchor that holds it. */
type BlockMarkupResidue = MarkupResidue & { anchorId: string };

// ── Helpers ────────────────────────────────────────────────

const normalize = (text: string): string =>
  text
    .replace(/\s+/gu, " ")
    .replace(/\u00a0/gu, " ")
    .trim()
    .toLowerCase();

const SKIP_WORDS = new Set([
  "[obrázek]",
  "obrázek",
  "česká",
  "republika",
  "jménem",
  "republiky",
  "pokračování",
]);

// Any Unicode letter, not an enumerated alphabet. This was a Latin
// list covering Czech, Polish, Slovak and German, which trimmed every
// Greek and Cyrillic word to nothing: such words then dropped out of
// both the source and the AST word set, so MISSING_WORDS could never
// fire for those languages. The CJEU corpus is published in all of
// them, and a completeness check that is silent for a script is worse
// than no check, because it reads as a pass.
const LETTER = /\p{L}/u;
const trimNonLetters = (word: string): string => {
  let start = 0;
  let end = word.length;

  while (start < end && !LETTER.test(word.charAt(start))) {
    start += 1;
  }
  while (end > start && !LETTER.test(word.charAt(end - 1))) {
    end -= 1;
  }

  return word.slice(start, end);
};

// A decorative marker sits flush against its neighbour in some source
// HTML ("[OBRÁZEK]ČESKÁ", "[OBRÁZEK][OBRÁZEK]"). Deleting the brackets
// alone fuses the marker to that neighbour, and the fused token
// ("obrázekčeská") matches no SKIP_WORDS entry, so a marker the AST is
// right to drop is reported missing. Same failure as the <br> gluing
// handled in validateAstReference: make the boundary a separator. Only a group
// whose content is itself skippable becomes one, because anonymization
// markers are mid-word ("[o]rganizace") and must stay joined.
//
// Scanned rather than matched with `/\[([^\]]*)\]/gu`: that literal is
// super-linear under scslre (the `super-linear-regexes` ratchet is at 0
// and stays there), and a court document is exactly the oversized input
// that turns the backtracking into blocking CPU. Both indexOf cursors
// only ever advance, so this is one pass over the text.
const separateSkipMarkers = (text: string): string => {
  let separated = "";
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf("[", index);
    const close = open === -1 ? -1 : text.indexOf("]", open + 1);
    if (close === -1) {
      return separated + text.slice(index);
    }
    const marker = trimNonLetters(text.slice(open + 1, close).toLowerCase());
    separated +=
      text.slice(index, open) +
      (SKIP_WORDS.has(marker) ? " " : text.slice(open, close + 1));
    index = close + 1;
  }
  return separated;
};

// What counts as a missing-word candidate: long enough to be meaningful,
// not a bare number, not a skip word. Shared so extractWords and the
// missing-word check judge a peeled remainder by the same rule; a short
// or numeric remainder is not a meaningful word, so a marker glued to one
// ("OBRÁZEKje") is not a lost word.
const isMeaningfulWord = (clean: string): boolean =>
  clean.length >= 3 && !/^\d+$/u.test(clean) && !SKIP_WORDS.has(clean);

const extractWords = (text: string): Set<string> => {
  const words = new Set<string>();
  for (const w of separateSkipMarkers(text).split(/\s+/u)) {
    // Strip brackets first (anonymization markers like
    // "[o]rganizace" or "[OBRÁZEK]"), then trim remaining
    // non-letter chars from edges.
    const noBrackets = w.replace(/[[\]]/gu, "");
    const clean = trimNonLetters(noBrackets.toLowerCase());
    if (isMeaningfulWord(clean) && !/^\[\d+\]$/u.test(w.toLowerCase())) {
      words.add(clean);
    }
  }
  return words;
};

// NSS renders decorative figures with the alt text "obrázek" (Czech for
// "image"). When one sits flush against its neighbour — as bracketless
// text, or across an inline-element boundary that cheerio's .text()
// concatenates with no space ("<span>Obrázek</span>Česká" →
// "ObrázekČeská") — there is no bracket for separateSkipMarkers to split
// on, so the fused token ("obrázekčeská") matches no AST word and no
// SKIP_WORDS entry and reads as missing. Peeling leading markers recovers
// the real remainder; the caller keeps a word only when that remainder is
// itself unaccounted for, so peeling can clear a phantom but never hides
// genuine loss.
const DECORATIVE_MARKERS = ["obrázek"];
const peelDecorativeMarkers = (word: string): string => {
  let peeled = word;
  let changed = true;
  while (changed) {
    changed = false;
    for (const marker of DECORATIVE_MARKERS) {
      if (peeled.length > marker.length && peeled.startsWith(marker)) {
        peeled = peeled.slice(marker.length);
        changed = true;
      }
    }
  }
  return peeled;
};

// Whether the source's extracted text is nothing but the publisher's own
// decorative furniture — a scan published as [OBRÁZEK] placeholders, the NSS
// emblem and its "ČESKÁ REPUBLIKA / JMÉNEM REPUBLIKY" header. Such a source
// has nothing for an AST to lose, so a retention ratio over its characters
// reports total loss against a faithful parse.
//
// Deliberately narrower than `isMeaningfulWord`, which also drops bare
// numbers and one- or two-letter tokens: those are content a decision can
// lose (awarded amounts, dates, a docket's parts, a roman-numbered ruling
// item), so reusing the missing-word filter here would silence real loss on a
// source whose text is entirely numeric. Only a token that peels away to
// nothing, or to a skip word, counts as decoration.
const CONTENT_CHAR = /[\p{L}\p{N}]/u;
const holdsOnlyDecoration = (text: string): boolean =>
  separateSkipMarkers(text)
    .split(/\s+/u)
    .every((word) => {
      const bare = word.replace(/[[\]]/gu, "").toLowerCase();
      if (!CONTENT_CHAR.test(bare) || SKIP_WORDS.has(bare)) {
        return true;
      }
      const peeled = peelDecorativeMarkers(bare);
      return peeled === "" || SKIP_WORDS.has(peeled);
    });

/** Elements whose text the reference extraction reads. */
const CONTENT_TAGS = ["p", "li", "td", "th", "div"] as const;
const CONTENT_SELECTOR = CONTENT_TAGS.join(", ");
const isContentTag = (name: string): boolean =>
  CONTENT_TAGS.some((tag) => tag === name);

/**
 * Whether any descendant is a content element. A walk rather than
 * `:has()`: css-select answers `:has()` by recursing once per nesting
 * level, which overflows the stack on deeply nested inline markup.
 */
const hasContentDescendant = (nodes: readonly AnyNode[]): boolean => {
  const pending = [...nodes];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (!isTag(node)) {
      continue;
    }
    if (isContentTag(node.name)) {
      return true;
    }
    for (const child of node.children) {
      pending.push(child);
    }
  }
  return false;
};

/** Flatten inline nodes to text (line-break → space). */
const inlineText = (inlines: readonly Inline[]): string => {
  let text = "";
  for (const node of inlines) {
    if (node.type === "text") {
      text += node.text;
    } else if (node.type === "line-break") {
      text += " ";
    } else if (node.type === "page-anchor") {
      // Typography, not content — no characters.
    } else {
      // Every remaining kind is a container: its text is its children's.
      text += inlineText(node.children);
    }
  }
  return text;
};

const collapseWhitespace = (text: string): string =>
  text.replace(/\s+/gu, " ").trim();

/** Issue code for source markup found in a block's text. */
const MARKUP_RESIDUE = "MARKUP_RESIDUE";
const BOUNDARY_WHITESPACE = "BOUNDARY_WHITESPACE";

const collectSourceText = (
  html: string,
  sourcePolicy: ValidationSourcePolicy | undefined,
): {
  originalText: string;
  work: ValidationResult["stats"]["work"];
} => {
  const $ = cheerio.load(html);
  $("div[style*='-aw-headerfooter-type']").remove();
  $("br").replaceWith(" ");

  const seen = new Set<string>();
  const originalParts: string[] = [];
  const normalizedTextCache = new WeakMap<object, string>();
  const work = { textComputations: 0, textCharacters: 0, ancestorChecks: 0 };
  const normalizedText = (el: Parameters<typeof $>[0] & object): string => {
    const cached = normalizedTextCache.get(el);
    if (cached !== undefined) {
      return cached;
    }
    work.textComputations += 1;
    const sourceText = visibleHtmlText($(el));
    const value = (
      sourcePolicy ? sourcePolicy.projectSourceText(sourceText) : sourceText
    )
      .replace(/\s+/gu, " ")
      .trim();
    work.textCharacters += value.length;
    normalizedTextCache.set(el, value);
    return value;
  };

  $(`body :is(${CONTENT_SELECTOR})`).each((_, el) => {
    const $el = $(el);
    if (el.name === "div" && hasContentDescendant(el.children)) {
      return;
    }
    const capturedByAncestor = $el
      .parents(CONTENT_SELECTOR)
      .toArray()
      .some((ancestor) => {
        work.ancestorChecks += 1;
        return seen.has(normalizedText(ancestor));
      });
    if (capturedByAncestor) {
      return;
    }
    const text = normalizedText(el);
    if (text && !seen.has(text)) {
      seen.add(text);
      originalParts.push(text);
    }
  });

  $("body img[alt]").each((_, el) => {
    const alt = $(el).attr("alt")?.trim();
    if (alt && !seen.has(alt)) {
      seen.add(alt);
      originalParts.push(alt);
    }
  });

  return { originalText: normalize(originalParts.join(" ")), work };
};

type BlockInspection = Pick<
  ValidationResult["stats"],
  | "blockTypeCounts"
  | "tinyBlocks"
  | "hugeBlocks"
  | "duplicateBlocks"
  | "markupResidue"
>;

const inspectBlocks = (
  blocks: Block[],
  sourcePolicy: ValidationSourcePolicy | undefined,
  issues: Issue[],
): BlockInspection => {
  const typeCounts = new Map<string, number>();
  let tinyBlocks = 0;
  let hugeBlocks = 0;
  let duplicateBlocks = 0;
  let prevText = "";
  const markupResidue: BlockMarkupResidue[] = [];

  for (const block of blocks) {
    const key =
      block.type === "paragraph" && block.role !== undefined
        ? `paragraph-${block.role}`
        : block.type;
    typeCounts.set(key, (typeCounts.get(key) ?? 0) + 1);

    const text = block.plainText.trim();
    const residue = sourcePolicy
      ? sourcePolicy.markupResidueIn(text)
      : markupResidueIn(text);
    if (residue) {
      markupResidue.push({ ...residue, anchorId: block.anchorId });
    }
    if (
      text.length > 0 &&
      text.length < 5 &&
      block.type !== "heading" &&
      block.type !== "image"
    ) {
      tinyBlocks += 1;
    }
    if (text.length > 5000) {
      hugeBlocks += 1;
    }
    if (text === prevText && text.length > 10) {
      duplicateBlocks += 1;
    }
    prevText = text;

    if (block.type !== "heading" && block.type !== "paragraph") {
      continue;
    }
    const inlineLen = (
      sourcePolicy
        ? sourcePolicy.projectInlineText(block.inlines)
        : collapseWhitespace(inlineText(block.inlines))
    ).length;
    const plainLen = collapseWhitespace(block.plainText).length;
    if (
      Math.abs(inlineLen - plainLen) > 5 &&
      Math.abs(inlineLen - plainLen) > plainLen * 0.05
    ) {
      issues.push({
        code: "INLINE_PLAINTEXT_MISMATCH",
        message:
          `Block "${text.slice(0, 40)}..." inline length ` +
          `(${inlineLen}) != plainText length (${plainLen})`,
        severity: "warning",
      });
    }
  }

  return {
    blockTypeCounts: Object.fromEntries(typeCounts),
    tinyBlocks,
    hugeBlocks,
    duplicateBlocks,
    markupResidue,
  };
};

// ── Validator ──────────────────────────────────────────────

export const validateAstReference = (
  html: string,
  blocks: Block[],
  options?: ValidationOptions,
): ValidationResult => {
  const { minRetainedPct = 90, maxMissingWords = 15 } = options ?? {};

  const issues: Issue[] = [];

  // ── 1. Content completeness ────────────────────────────

  const { originalText, work } = collectSourceText(html, options?.sourcePolicy);

  const astText = normalize(
    blocks.flatMap((b) => (b.plainText ? [b.plainText] : [])).join(" "),
  );

  const originalWords = extractWords(originalText);
  const astWords = extractWords(astText);

  const sourceHasContent = !holdsOnlyDecoration(originalText);

  const retainedPct = sourceHasContent
    ? (astText.length / originalText.length) * 100
    : 100;

  // A decorative marker fused to its neighbour must not read as missing
  // when the peeled remainder is accounted for. It is accounted for when
  // it is present in the AST, or when it is not a meaningful word in its
  // own right (a skip word, or too short/numeric to count) — judged by
  // the same rule extractWords applies. Peeling only ever clears a
  // phantom: a genuinely absent meaningful word keeps a remainder that is
  // meaningful and not in the AST, so real loss is still reported.
  const missingFrom = (words: Set<string>): string[] =>
    [...words].filter((w) => {
      if (astWords.has(w)) {
        return false;
      }
      const peeled = peelDecorativeMarkers(w);
      return isMeaningfulWord(peeled) && !astWords.has(peeled);
    });
  // A comparison view that changes anything but whitespace is ignored, so the
  // check falls back to the source words and a real loss stays visible.
  const wordComparisonText = options?.wordComparisonText;
  const comparisonWords =
    wordComparisonText === undefined ||
    normalize(wordComparisonText).replace(/\s+/gu, "") !==
      originalText.replace(/\s+/gu, "")
      ? originalWords
      : extractWords(normalize(wordComparisonText));
  const missingWords = missingFrom(comparisonWords);
  const boundaryWhitespaceWords =
    comparisonWords === originalWords
      ? []
      : missingFrom(originalWords).filter((word) => !comparisonWords.has(word));

  if (retainedPct < minRetainedPct) {
    issues.push({
      code: "CONTENT_LOSS",
      message:
        `Only ${retainedPct.toFixed(1)}% of text retained ` +
        `(threshold: ${minRetainedPct}%)`,
      severity: "error",
    });
  }

  if (missingWords.length > maxMissingWords) {
    issues.push({
      code: "MISSING_WORDS",
      message: `${missingWords.length} meaningful words missing: ${missingWords.slice(0, 10).join(", ")}`,
      severity: "error",
    });
  }

  if (boundaryWhitespaceWords.length > 0) {
    issues.push({
      code: BOUNDARY_WHITESPACE,
      message: `${boundaryWhitespaceWords.length} source words cross an inline break`,
      severity: "warning",
    });
  }

  // ── 2. Structural checks ──────────────────────────────

  if (blocks.length === 0) {
    // No blocks is loss only when there was something to lose. A source
    // carrying nothing but decoration is represented faithfully by no blocks,
    // and `retainedPct` reads 100 for it; calling that an error reports
    // content loss against a document whose emptiness the pipeline
    // separately reports as `decision_empty`, sending whoever sweeps these
    // logs after a parser bug that is not there. It stays an issue, so the
    // parse still surfaces as structurally degraded.
    issues.push({
      code: "EMPTY_AST",
      message: "AST has no blocks",
      severity: sourceHasContent ? "error" : "warning",
    });
  }

  const headingCount = blocks.filter(
    (block) => block.type === "heading",
  ).length;
  if (headingCount === 0) {
    issues.push({
      code: "NO_HEADINGS",
      message: "AST has no heading blocks",
      severity: "warning",
    });
  }

  const {
    blockTypeCounts,
    tinyBlocks,
    hugeBlocks,
    duplicateBlocks,
    markupResidue,
  } = inspectBlocks(blocks, options?.sourcePolicy, issues);

  if (tinyBlocks > blocks.length * 0.3) {
    issues.push({
      code: "TOO_MANY_TINY_BLOCKS",
      message:
        `${tinyBlocks}/${blocks.length} blocks have < 5 chars ` +
        `(${((tinyBlocks / blocks.length) * 100).toFixed(0)}%)`,
      severity: "warning",
    });
  }

  if (hugeBlocks > 0) {
    issues.push({
      code: "HUGE_BLOCKS",
      message: `${hugeBlocks} blocks exceed 5000 chars`,
      severity: "warning",
    });
  }

  if (duplicateBlocks > 0) {
    issues.push({
      code: "DUPLICATE_BLOCKS",
      message: `${duplicateBlocks} consecutive duplicate blocks`,
      severity: "warning",
    });
  }

  const firstResidue = markupResidue.at(0);
  if (firstResidue) {
    issues.push({
      code: MARKUP_RESIDUE,
      message:
        `${markupResidue.length} block(s) carry source markup ` +
        `(${firstResidue.reason} at ${firstResidue.anchorId}): ${
          firstResidue.excerpt
        }`,
      severity: "error",
    });
  }

  const hasErrors = issues.some((i) => i.severity === "error");

  return {
    ok: !hasErrors,
    issues,
    stats: {
      originalLength: originalText.length,
      astLength: astText.length,
      retainedPct: Math.round(retainedPct * 10) / 10,
      blockCount: blocks.length,
      missingWords,
      boundaryWhitespaceWords,
      blockTypeCounts,
      tinyBlocks,
      hugeBlocks,
      duplicateBlocks,
      markupResidue,
      work,
    },
  };
};
