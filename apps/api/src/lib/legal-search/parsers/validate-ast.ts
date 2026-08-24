/**
 * AST sanity checker.
 *
 * Every parser MUST call `validateAst` after producing blocks.
 * It checks for content loss, structural anomalies, and
 * formatting issues. Violations are logged as warnings;
 * in tests, the result can be asserted.
 */

import * as cheerio from "cheerio";

import type { Block, Inline } from "@/api/lib/case-law/document-ast";
import { logger } from "@/api/lib/observability/logger";

// ── Types ──────────────────────────────────────────────────

type Issue = {
  code: string;
  message: string;
  severity: "error" | "warning";
};

export type ValidationResult = {
  ok: boolean;
  issues: Issue[];
  stats: {
    originalLength: number;
    astLength: number;
    retainedPct: number;
    blockCount: number;
    missingWords: string[];
    blockTypeCounts: Record<string, number>;
    /** Blocks with suspiciously short text (< 5 chars). */
    tinyBlocks: number;
    /** Blocks with very long text (> 5000 chars). */
    hugeBlocks: number;
    /** Consecutive duplicate plainText blocks. */
    duplicateBlocks: number;
  };
};

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
// handled in validateAst: make the boundary a separator. Only a group
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

/** Flatten inline nodes to text (line-break → space). */
const inlineText = (inlines: readonly Inline[]): string => {
  let text = "";
  for (const node of inlines) {
    if (node.type === "text") {
      text += node.text;
    } else if (node.type === "line-break") {
      text += " ";
    } else {
      // bold | italic | link — all carry children
      text += inlineText(node.children);
    }
  }
  return text;
};

const collapseWhitespace = (text: string): string =>
  text.replace(/\s+/gu, " ").trim();

// ── Validator ──────────────────────────────────────────────

export const validateAst = (
  html: string,
  blocks: Block[],
  options?: {
    minRetainedPct?: number;
    maxMissingWords?: number;
  },
): ValidationResult => {
  const { minRetainedPct = 90, maxMissingWords = 15 } = options ?? {};

  const issues: Issue[] = [];

  // ── 1. Content completeness ────────────────────────────

  const $ = cheerio.load(html);
  $("div[style*='-aw-headerfooter-type']").remove();

  // <br> is a word boundary in the rendered document, but cheerio's
  // .text() drops it outright, gluing adjacent words ("wraz<br/>z" →
  // "wrazz") and producing phantom MISSING_WORDS reports against a
  // correct AST. Make it a space before extracting reference text.
  $("br").replaceWith(" ");

  // Extract text from content elements, but skip nested
  // elements whose text is already included by a parent
  // (e.g., <td> inside <td> in NALUS HTML).
  const contentSelector = "p, li, td, th, div";
  const seen = new Set<string>();
  const originalParts: string[] = [];
  // Stringifying a node visits its whole subtree, and the ancestor check
  // below runs it for every ancestor of every content element — quadratic
  // on flat many-paragraph documents. Each node's normalized text is
  // computed once and reused.
  const normalizedTextCache = new WeakMap<object, string>();
  const normalizedText = (el: Parameters<typeof $>[0] & object): string => {
    const cached = normalizedTextCache.get(el);
    if (cached !== undefined) {
      return cached;
    }
    const value = $(el).text().replace(/\s+/gu, " ").trim();
    normalizedTextCache.set(el, value);
    return value;
  };
  $("body")
    .find(contentSelector)
    .each((_, el) => {
      const $el = $(el);

      // Skip <div> wrappers that contain child content
      // elements — those children are matched separately.
      if (
        el.tagName.toLowerCase() === "div" &&
        $el.find("p, li, td, th, div").length > 0
      ) {
        return;
      }

      // Skip if any ancestor in our selector already captured this
      // text. Checking every ancestor rather than just the nearest one
      // matters for sources that nest content two or more levels deep
      // (Cellar quotes legislation as a table inside the cell of the
      // numbered paragraph that introduces it): with only the nearest
      // ancestor checked, the inner text is counted once inside the
      // outer cell and again on its own, and the inflated original
      // length reads as content loss in an otherwise complete AST.
      const capturedByAncestor = $el
        .parents(contentSelector)
        .toArray()
        .some((ancestor) => seen.has(normalizedText(ancestor)));
      if (capturedByAncestor) {
        return;
      }
      const text = normalizedText(el);
      if (text && !seen.has(text)) {
        seen.add(text);
        originalParts.push(text);
      }
    });

  // Also collect <img> alt text (some courts embed
  // meaningful text in alt attributes).
  $("body")
    .find("img[alt]")
    .each((_, el) => {
      const alt = $(el).attr("alt")?.trim();
      if (alt && !seen.has(alt)) {
        seen.add(alt);
        originalParts.push(alt);
      }
    });

  const originalText = normalize(originalParts.join(" "));

  const astText = normalize(
    blocks.flatMap((b) => (b.plainText ? [b.plainText] : [])).join(" "),
  );

  const retainedPct =
    originalText.length > 0
      ? (astText.length / originalText.length) * 100
      : 100;

  const originalWords = extractWords(originalText);
  const astWords = extractWords(astText);
  // A decorative marker fused to its neighbour must not read as missing
  // when the peeled remainder is accounted for. It is accounted for when
  // it is present in the AST, or when it is not a meaningful word in its
  // own right (a skip word, or too short/numeric to count) — judged by
  // the same rule extractWords applies. Peeling only ever clears a
  // phantom: a genuinely absent meaningful word keeps a remainder that is
  // meaningful and not in the AST, so real loss is still reported.
  const missingWords = [...originalWords].filter((w) => {
    if (astWords.has(w)) {
      return false;
    }
    const peeled = peelDecorativeMarkers(w);
    return isMeaningfulWord(peeled) && !astWords.has(peeled);
  });

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

  // ── 2. Structural checks ──────────────────────────────

  if (blocks.length === 0) {
    // No blocks is loss only when there was something to lose. A source
    // carrying no extractable text is represented faithfully by no
    // blocks, and `retainedPct` already reads 100 for it; calling that an
    // error reports content loss against a document whose emptiness the
    // pipeline separately reports as `decision_empty`, sending whoever
    // sweeps these logs after a parser bug that is not there. It stays an
    // issue, so the parse still surfaces as structurally degraded.
    issues.push({
      code: "EMPTY_AST",
      message: "AST has no blocks",
      severity: originalText.length > 0 ? "error" : "warning",
    });
  }

  // Block type distribution
  const typeCounts: Record<string, number> = {};
  for (const b of blocks) {
    const key =
      b.type === "paragraph" && b.role !== undefined
        ? `paragraph-${b.role}`
        : b.type;
    typeCounts[key] = (typeCounts[key] ?? 0) + 1;
  }

  // Must have at least one heading
  const headingCount = blocks.filter((b) => b.type === "heading").length;
  if (headingCount === 0) {
    issues.push({
      code: "NO_HEADINGS",
      message: "AST has no heading blocks",
      severity: "warning",
    });
  }

  // ── 3. Block-level anomalies ──────────────────────────

  let tinyBlocks = 0;
  let hugeBlocks = 0;
  let duplicateBlocks = 0;
  let prevText = "";

  for (const block of blocks) {
    const text = block.plainText.trim();

    // Tiny blocks (excluding headings which can be short)
    if (text.length > 0 && text.length < 5 && block.type !== "heading") {
      tinyBlocks++;
    }

    // Huge blocks
    if (text.length > 5000) {
      hugeBlocks++;
    }

    // Consecutive duplicates
    if (text === prevText && text.length > 10) {
      duplicateBlocks++;
    }
    prevText = text;

    // ── 4. Inline-plainText consistency ─────────────────

    if (block.type === "heading" || block.type === "paragraph") {
      // Parsers normalize plainText while inlines keep source spacing;
      // compare whitespace-collapsed forms so padding never flags.
      const inlineLen = collapseWhitespace(inlineText(block.inlines)).length;
      const plainLen = collapseWhitespace(block.plainText).length;
      // Allow some tolerance for whitespace differences
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
  }

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
      blockTypeCounts: typeCounts,
      tinyBlocks,
      hugeBlocks,
      duplicateBlocks,
    },
  };
};

/**
 * Identity of the document being validated.
 *
 * A case number alone does not identify a document: courts that
 * publish in several languages emit one variant per language under the
 * same number, and a case can carry both a judgment and an Advocate
 * General's opinion. Anything acting on these logs — a person or an
 * agent sweeping for bad parses — needs enough here to fetch the exact
 * document back.
 */
export type ValidationSubject = {
  /** Adapter key, e.g. "eu-ecj". */
  parser: string;
  caseNumber: string;
  language?: string | undefined;
  /** Where this exact document can be re-fetched. */
  url?: string | undefined;
};

/**
 * Log event emitted when source text did not survive into the AST.
 * Reported at ERROR: the text is unrecoverable from the stored
 * decision, and neither the reader nor the AI pipeline can tell.
 */
export const AST_CONTENT_LOST = "case_law.ingestion.ast_content_lost";

/**
 * Log event emitted when the text is all present but its structure is
 * wrong or missing. Reported at WARN: degraded, not incorrect.
 */
export const AST_STRUCTURE_DEGRADED =
  "case_law.ingestion.ast_structure_degraded";

/**
 * Log event emitted when a decision is stored with neither text nor an
 * AST. Reported at ERROR: nothing about the decision is readable, and
 * a source that starts doing this emits no other signal, because its
 * parser never runs.
 */
export const DECISION_EMPTY = "case_law.ingestion.decision_empty";

/**
 * Log event emitted when a decision is stored with text but no AST —
 * the unstructured-wall-of-text state. Reported at WARN.
 */
export const AST_MISSING = "case_law.ingestion.ast_missing";

/**
 * What a stored decision reports about itself, before any parser
 * result is considered.
 *
 * Kept as a pure function rather than inline branching in the pipeline
 * because this is the signal an operator or agent sweeps for; a change
 * that silently downgrades it would otherwise be invisible, and the
 * one place it must not be invisible is here.
 */
export type StoredDecisionSignal =
  | { event: typeof DECISION_EMPTY; level: "error" }
  | { event: typeof AST_MISSING; level: "warn" };

export const storedDecisionSignal = (stored: {
  hasFulltext: boolean;
  astBlocks: number;
}): StoredDecisionSignal | undefined => {
  if (stored.astBlocks > 0) {
    return undefined;
  }
  return stored.hasFulltext
    ? { event: AST_MISSING, level: "warn" }
    : { event: DECISION_EMPTY, level: "error" };
};

/**
 * Validate, then log the outcome under a severity that reflects what
 * kind of failure it is. Returns the result for callers that want to
 * assert on it.
 */
export type ValidationSignal =
  | { event: typeof AST_CONTENT_LOST; level: "error" }
  | { event: typeof AST_STRUCTURE_DEGRADED; level: "warn" };

/**
 * Map a validation outcome onto the event an operator sweeps for.
 * Pure, and tested as such: this mapping is the whole value of the
 * signal, and a change that quietly turns loss into a warning would
 * otherwise show up only as an absence in a log search.
 */
export const validationSignal = (
  result: Pick<ValidationResult, "ok" | "issues">,
): ValidationSignal | undefined => {
  if (result.issues.length === 0) {
    return undefined;
  }
  return result.ok
    ? { event: AST_STRUCTURE_DEGRADED, level: "warn" }
    : { event: AST_CONTENT_LOST, level: "error" };
};

export const validateAndLog = (
  subject: ValidationSubject,
  html: string,
  blocks: Block[],
): ValidationResult => {
  const result = validateAst(html, blocks);
  const signal = validationSignal(result);
  if (!signal) {
    return result;
  }

  // Court decisions are public documents; log full diagnostics so a
  // failure is actionable straight from the log line, without
  // re-fetching and re-parsing the source.
  const common = {
    parser: subject.parser,
    caseNumber: subject.caseNumber,
    ...(subject.language === undefined ? {} : { language: subject.language }),
    ...(subject.url === undefined ? {} : { url: subject.url }),
    codes: result.issues.map((issue) => issue.code).join(","),
    issues: result.issues
      .map((issue) => `${issue.code}: ${issue.message}`)
      .join("; "),
    blockCount: result.stats.blockCount,
  };

  if (signal.level === "warn") {
    logger.warn(signal.event, common);
    return result;
  }

  logger.error(signal.event, {
    ...common,
    retainedPct: result.stats.retainedPct,
    missingWordCount: result.stats.missingWords.length,
    missingWords: result.stats.missingWords.slice(0, 25).join(", "),
  });

  return result;
};

/**
 * Build minimal validation HTML from structured paragraphs.
 *
 * For parsers that consume structured data (JSON sections, RTF
 * paragraphs) rather than raw HTML, the source HTML is unsuitable
 * for validation: text from adjacent sections gets concatenated
 * without whitespace, creating phantom words like "zamítá.ii."
 * that the AST rightfully doesn't contain.
 *
 * This utility wraps each paragraph in a `<p>` tag so the
 * validator's cheerio-based word extraction sees proper word
 * boundaries between paragraphs.
 */
export const buildValidationHtml = (paragraphs: readonly string[]): string => {
  const parts: string[] = [];
  for (const p of paragraphs) {
    if (p.trim()) {
      parts.push(`<p>${p}</p>`);
    }
  }
  return `<body>${parts.join("")}</body>`;
};
