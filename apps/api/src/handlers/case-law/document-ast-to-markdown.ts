/**
 * Convert a DocumentAst to clean markdown for AI consumption.
 *
 * Produces a readable markdown representation that preserves
 * the document structure: headings, ruling items, paragraphs,
 * bold/italic, and tables. Designed for use as LLM context.
 */

import type {
  Block,
  DocumentAst,
  Inline,
} from "@/api/handlers/case-law/document-ast";

const inlineToMarkdown = (node: Inline): string => {
  if (node.type === "text") {
    return node.text;
  }
  if (node.type === "line-break") {
    return "\n";
  }
  if (node.type === "bold") {
    const inner = node.children.map(inlineToMarkdown).join("");
    return inner ? `**${inner}**` : "";
  }
  if (node.type === "italic") {
    const inner = node.children.map(inlineToMarkdown).join("");
    return inner ? `*${inner}*` : "";
  }
  if (node.type === "link") {
    const inner = node.children.map(inlineToMarkdown).join("");
    return `[${inner}](${node.href})`;
  }
  return "";
};

const inlinesToMarkdown = (inlines: Inline[]): string =>
  inlines.map(inlineToMarkdown).join("");

const blockToMarkdown = (block: Block): string => {
  if (block.type === "heading") {
    const prefix = "#".repeat(block.level);
    return `${prefix} ${inlinesToMarkdown(block.inlines)}`;
  }

  if (block.type === "ruling-item") {
    const label = block.label ?? "-";
    return `${label} ${inlinesToMarkdown(block.inlines)}`;
  }

  if (block.type === "paragraph") {
    if (block.role === "case-number") {
      return `> ${block.plainText}`;
    }
    if (block.role === "closing" || block.role === "signature") {
      return `*${block.plainText}*`;
    }
    return inlinesToMarkdown(block.inlines);
  }

  // table
  return block.rows
    .map((row) => row.map((cell) => cell.plainText).join(" | "))
    .join("\n");
};

/**
 * Convert a full DocumentAst to markdown.
 *
 * @param ast - The document AST.
 * @param options - Optional configuration.
 * @returns Markdown string.
 */
export const documentAstToMarkdown = (
  ast: DocumentAst,
  options?: {
    /** Include metadata header (court, case number, date). */
    includeMetadata?: boolean;
    /** Maximum character length (truncates with "…"). */
    maxLength?: number;
  },
): string => {
  const { includeMetadata = true, maxLength } = options ?? {};

  const parts: string[] = [];

  if (includeMetadata) {
    const meta = ast.metadata;
    const headerParts: string[] = [];
    if (meta.court) {
      headerParts.push(`**Court:** ${meta.court}`);
    }
    if (meta.caseNumber) {
      headerParts.push(`**Case:** ${meta.caseNumber}`);
    }
    if (meta.ecli) {
      headerParts.push(`**ECLI:** ${meta.ecli}`);
    }
    if (meta.decisionDate) {
      headerParts.push(`**Date:** ${meta.decisionDate}`);
    }
    if (meta.decisionType) {
      headerParts.push(`**Type:** ${meta.decisionType}`);
    }
    if (headerParts.length > 0) {
      parts.push(headerParts.join("  \n"));
      parts.push("---");
    }
  }

  for (const block of ast.blocks) {
    parts.push(blockToMarkdown(block));
  }

  let result = parts.join("\n\n");

  if (maxLength !== undefined && maxLength > 0 && result.length > maxLength) {
    result = `${result.slice(0, maxLength - 1)}…`;
  }

  return result;
};
