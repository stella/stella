/**
 * AST sanity checker.
 *
 * Every parser MUST call `validateAst` after producing blocks.
 * It checks for content loss, structural anomalies, and
 * formatting issues. Violations are logged as warnings;
 * in tests, the result can be asserted.
 */

import * as cheerio from "cheerio";

import type { Block, Inline } from "@/api/handlers/case-law/document-ast";
import { logger } from "@/api/lib/observability/logger";

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

const LETTERS = new Set("abcdefghijklmnopqrstuvwxyzáčďéěíňóřšťúůýž");
const trimNonLetters = (word: string): string => {
  let start = 0;
  let end = word.length;

  while (start < end && !LETTERS.has(word.charAt(start))) {
    start += 1;
  }
  while (end > start && !LETTERS.has(word.charAt(end - 1))) {
    end -= 1;
  }

  return word.slice(start, end);
};

const extractWords = (text: string): Set<string> => {
  const words = new Set<string>();
  for (const w of text.split(/\s+/u)) {
    // Strip brackets first (anonymization markers like
    // "[o]rganizace" or "[OBRÁZEK]"), then trim remaining
    // non-letter chars from edges.
    const noBrackets = w.replace(/[[\]]/gu, "");
    const clean = trimNonLetters(noBrackets.toLowerCase());
    if (
      clean.length >= 3 &&
      !/^\d+$/u.test(clean) &&
      !/^\[\d+\]$/u.test(w.toLowerCase()) &&
      !SKIP_WORDS.has(clean)
    ) {
      words.add(clean);
    }
  }
  return words;
};

/** Count characters across all inline nodes. */
const inlineTextLength = (inlines: readonly Inline[]): number => {
  let len = 0;
  for (const node of inlines) {
    if (node.type === "text") {
      len += node.text.length;
    } else if (node.type === "line-break") {
      len += 1;
    } else if ("children" in node) {
      len += inlineTextLength(node.children);
    }
  }
  return len;
};

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

  // Extract text from content elements, but skip nested
  // elements whose text is already included by a parent
  // (e.g., <td> inside <td> in NALUS HTML).
  const contentSelector = "p, li, td, th, div";
  const seen = new Set<string>();
  const originalParts: string[] = [];
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

      // Skip if a parent element in our selector already
      // captured this text (prevents double-counting).
      if ($el.parents(contentSelector).length > 0) {
        const parentText = $el
          .parent()
          .closest(contentSelector)
          .text()
          .replace(/\s+/gu, " ")
          .trim();
        if (seen.has(parentText)) {
          return;
        }
      }
      const text = $el.text().replace(/\s+/gu, " ").trim();
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
    blocks
      .map((b) => b.plainText)
      .filter(Boolean)
      .join(" "),
  );

  const retainedPct =
    originalText.length > 0
      ? (astText.length / originalText.length) * 100
      : 100;

  const originalWords = extractWords(originalText);
  const astWords = extractWords(astText);
  const missingWords = [...originalWords].filter((w) => !astWords.has(w));

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
    issues.push({
      code: "EMPTY_AST",
      message: "AST has no blocks",
      severity: "error",
    });
  }

  // Block type distribution
  const typeCounts: Record<string, number> = {};
  for (const b of blocks) {
    const key =
      b.type === "paragraph" && "role" in b ? `paragraph-${b.role}` : b.type;
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

    if ("inlines" in block) {
      const inlineLen = inlineTextLength(block.inlines);
      const plainLen = block.plainText.length;
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
 * Convenience: validate and log issues. Returns the result
 * for callers that want to inspect it.
 */
export const validateAndLog = (
  parserName: string,
  caseNumber: string,
  html: string,
  blocks: Block[],
): ValidationResult => {
  const result = validateAst(html, blocks);

  if (!result.ok) {
    logger.error("case_law.ingestion.ast_validation_failed", {
      parser: parserName,
      caseNumber,
      issues: result.issues.length,
      missingWords: result.stats.missingWords.length,
      retainedPct: result.stats.retainedPct,
    });
  } else if (result.issues.length > 0) {
    logger.warn("case_law.ingestion.ast_validation_warning", {
      parser: parserName,
      caseNumber,
      issues: result.issues.length,
    });
  }

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
  const parts = paragraphs.filter((p) => p.trim()).map((p) => `<p>${p}</p>`);
  return `<body>${parts.join("")}</body>`;
};
