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
    .replace(/\s+/g, " ")
    .replace(/\u00a0/g, " ")
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

const extractWords = (text: string): Set<string> => {
  const words = new Set<string>();
  for (const w of text.split(/\s+/)) {
    const clean = w
      .toLowerCase()
      .replace(/^[^a-záčďéěíňóřšťúůýž]+/, "")
      .replace(/[^a-záčďéěíňóřšťúůýž]+$/, "");
    if (
      clean.length >= 3 &&
      !/^\d+$/.test(clean) &&
      !/^\[\d+\]$/.test(w.toLowerCase()) &&
      !SKIP_WORDS.has(clean)
    ) {
      words.add(clean);
    }
  }
  return words;
};

/** Count characters across all inline nodes. */
const inlineTextLength = (inlines: Inline[]): number => {
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
  const seen = new Set<string>();
  const originalParts: string[] = [];
  $("body")
    .find("p, li, td, th")
    .each((_, el) => {
      // Skip if a parent element in our selector already
      // captured this text (prevents double-counting).
      if ($(el).parents("p, li, td, th").length > 0) {
        const parentText = $(el)
          .parent()
          .closest("p, li, td, th")
          .text()
          .replace(/\s+/g, " ")
          .trim();
        if (seen.has(parentText)) {
          return;
        }
      }
      const text = $(el).text().replace(/\s+/g, " ").trim();
      if (text && !seen.has(text)) {
        seen.add(text);
        originalParts.push(text);
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
      b.type === "paragraph" && "role" in b && b.role
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
    // eslint-disable-next-line no-console -- parser diagnostic
    console.warn(`[${parserName}] AST validation failed for ${caseNumber}:`);
    for (const issue of result.issues) {
      // eslint-disable-next-line no-console -- parser diagnostic
      console.warn(`  ${issue.severity}: ${issue.message}`);
    }
  } else if (result.issues.length > 0) {
    // eslint-disable-next-line no-console -- parser diagnostic
    console.warn(`[${parserName}] AST warnings for ${caseNumber}:`);
    for (const issue of result.issues) {
      // eslint-disable-next-line no-console -- parser diagnostic
      console.warn(`  ${issue.severity}: ${issue.message}`);
    }
  }

  return result;
};

// Re-export old name for backward compatibility
export const validateAstCompleteness = validateAst;
