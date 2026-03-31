/**
 * Lightweight AST → markdown for AI context injection.
 * Runs on the frontend; mirrors the backend converter.
 */

type Inline =
  | { type: "text"; text: string }
  | { type: "bold"; children: Inline[] }
  | { type: "italic"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] }
  | { type: "line-break" };

type Block = {
  type: string;
  level?: number;
  label?: string | null;
  role?: string;
  inlines?: Inline[];
  plainText: string;
  rows?: { plainText: string }[][];
};

type DocumentAst = {
  metadata?: {
    court?: string | null;
    caseNumber?: string | null;
    ecli?: string | null;
    decisionDate?: string | null;
    decisionType?: string | null;
  };
  blocks: Block[];
};

const inlineToMd = (n: Inline): string => {
  if (n.type === "text") {
    return n.text;
  }
  if (n.type === "line-break") {
    return "\n";
  }
  if (n.type === "bold") {
    const s = n.children.map(inlineToMd).join("");
    return s ? `**${s}**` : "";
  }
  if (n.type === "italic") {
    const s = n.children.map(inlineToMd).join("");
    return s ? `*${s}*` : "";
  }
  if (n.type === "link") {
    return n.children.map(inlineToMd).join("");
  }
  return "";
};

const blockToMd = (b: Block): string => {
  if (b.type === "heading") {
    const prefix = "#".repeat(b.level ?? 1);
    return `${prefix} ${b.inlines?.map(inlineToMd).join("") ?? b.plainText}`;
  }
  if (b.type === "ruling-item") {
    return `${b.label ?? "-"} ${b.inlines?.map(inlineToMd).join("") ?? b.plainText}`;
  }
  if (b.type === "table" && b.rows) {
    return b.rows
      .map((row) => row.map((c) => c.plainText).join(" | "))
      .join("\n");
  }
  return b.inlines?.map(inlineToMd).join("") ?? b.plainText;
};

/**
 * Convert a case law decision to markdown for AI context.
 * Returns null if no AST is available.
 */
export const decisionToMarkdown = (
  ast: unknown,
  maxLength = 60_000,
): string | null => {
  /* oxlint-disable typescript/strict-boolean-expressions, typescript/no-unsafe-type-assertion -- ast is jsonb (unknown), runtime narrowing required */
  if (
    !ast ||
    typeof ast !== "object" ||
    !("blocks" in ast) ||
    !Array.isArray((ast as DocumentAst).blocks)
  ) {
    return null;
  }

  const doc = ast as DocumentAst;
  /* oxlint-enable typescript/strict-boolean-expressions, typescript/no-unsafe-type-assertion */
  const parts: string[] = [];

  if (doc.metadata) {
    const m = doc.metadata;
    const h: string[] = [];
    if (m.court) {
      h.push(`**Court:** ${m.court}`);
    }
    if (m.caseNumber) {
      h.push(`**Case:** ${m.caseNumber}`);
    }
    if (m.ecli) {
      h.push(`**ECLI:** ${m.ecli}`);
    }
    if (m.decisionDate) {
      h.push(`**Date:** ${m.decisionDate}`);
    }
    if (h.length > 0) {
      parts.push(h.join("  \n"));
      parts.push("---");
    }
  }

  for (const block of doc.blocks) {
    parts.push(blockToMd(block));
  }

  let result = parts.join("\n\n");
  if (result.length > maxLength) {
    result = `${result.slice(0, maxLength - 1)}…`;
  }
  return result;
};
