/**
 * Chat-export citation rendering.
 *
 * Turns the stored citation model ({@link JustificationBlock}, the same union
 * document review produces via `parse-justifications.ts`) into the citation
 * content appended to an exported message, honouring the verified/unverified
 * grounding status.
 *
 * The rule that makes an exported memo trustworthy: only a *grounded* citation
 * becomes a real source. A `docx-folio` citation the model could not match to
 * an allow-listed source block (`citationStatus: "unverified"`) never yields a
 * source line — it degrades to a plain "(unverified)" marker so an exported
 * document can never launder an ungrounded quote into an authoritative-looking
 * footnote. A `pdf-bates` citation is a page locator into a produced document,
 * grounded by construction, so it always yields a source.
 *
 * Pure and DB-free: every branch is exercised by unit tests. The handler
 * (`export-message.ts`) fetches the blocks and feeds them here.
 */

import type { JustificationBlock } from "@/api/db/schema";
import type { ChatSourceDocument } from "@/api/handlers/chat/tools/chat-source-document";
import { unreachable } from "@/api/lib/errors/tagged-errors";

// Derived from the block union rather than imported from the schema barrel:
// the stored citation type is deliberately not re-exported there, so the
// migration-coverage guard never reads a type-only change as a schema change
// (mirrors `parse-justifications.ts`).
type DocxFolioJustificationCitation = Extract<
  JustificationBlock,
  { kind: "docx-folio" }
>["statements"][number]["citations"][number];

export const CHAT_EXPORT_FORMATS = ["docx"] as const;
export type ChatExportFormat = (typeof CHAT_EXPORT_FORMATS)[number];

export const CHAT_EXPORT_CITATION_STYLES = [
  "footnotes",
  "inline",
  "none",
] as const;
export type ChatExportCitationStyle =
  (typeof CHAT_EXPORT_CITATION_STYLES)[number];

/** Heading for the appended citation section (Heading 2 in the DOCX). */
export const CHAT_EXPORT_SOURCES_HEADING = "Sources";

/** Marker rendered in place of a source for an ungrounded citation. */
export const CHAT_EXPORT_UNVERIFIED_MARKER = "(unverified)";

/** A citation resolved for export: either a grounded source (which becomes a
 *  numbered/inline source entry) or an ungrounded marker that carries NO
 *  source text. */
export type ResolvedExportCitation =
  | { status: "verified"; source: string }
  | { status: "unverified" };

const MARKDOWN_INLINE_ESCAPE = /(?<character>[\\`*_~[\]<>|])/gu;

/**
 * Render an untrusted document title as one Markdown-safe inline label.
 * Collapsing whitespace prevents embedded newlines from starting headings or
 * lists; escaping inline punctuation prevents emphasis, links, code, and HTML.
 */
const normalizeMarkdownSource = (source: string): string =>
  source
    .trim()
    .replace(/\s+/gu, " ")
    .replace(MARKDOWN_INLINE_ESCAPE, "\\$<character>");

/** A `pdf-bates` block's per-statement citation shape. Derived from the schema
 *  union so it stays in lockstep with the stored model. */
type PdfBatesCitation = Extract<
  JustificationBlock,
  { kind: "pdf-bates" }
>["statements"][number]["citations"][number];

/**
 * Whether a stored `docx-folio` citation is ungrounded.
 *
 * Only an explicit `"unverified"` is demoted; a missing/legacy status is
 * treated as verified, matching the citation model's legacy default (rows
 * written before the status field existed carry a grounded quote).
 */
export const isUnverifiedDocxCitation = (citation: {
  citationStatus?: "verified" | "unverified";
}): boolean => citation.citationStatus === "unverified";

/** A Bates locator is grounded by construction, so it is always a source. */
const resolvePdfBatesCitation = (
  citation: PdfBatesCitation,
  fileName: string | undefined,
): ResolvedExportCitation => {
  const locator = `${citation.bates} (p. ${citation.pageNumber})`;
  return {
    status: "verified",
    source: fileName ? `${fileName}, ${locator}` : locator,
  };
};

/** A grounded `docx-folio` quote carries the block text; an unverified one
 *  carries only the model's hint, so it never becomes a source. */
const resolveDocxFolioCitation = (
  citation: DocxFolioJustificationCitation,
): ResolvedExportCitation =>
  isUnverifiedDocxCitation(citation)
    ? { status: "unverified" }
    : { status: "verified", source: citation.text };

type FileNameByFieldId = ReadonlyMap<string, string>;

/**
 * Flatten stored justification blocks into resolved export citations, switching
 * over the citation union per kind. `playbook-verdict` blocks carry no source
 * reference (a verdict is graded against a tiered standard, not a document
 * span), so they contribute no citations to an export.
 */
export const resolveExportCitations = (
  blocks: readonly JustificationBlock[],
  fileNameByFieldId: FileNameByFieldId = new Map(),
): ResolvedExportCitation[] => {
  const resolved: ResolvedExportCitation[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case "pdf-bates": {
        const fileName = fileNameByFieldId.get(block.fileFieldId);
        for (const statement of block.statements) {
          for (const citation of statement.citations) {
            resolved.push(resolvePdfBatesCitation(citation, fileName));
          }
        }
        break;
      }
      case "docx-folio": {
        for (const statement of block.statements) {
          for (const citation of statement.citations) {
            resolved.push(resolveDocxFolioCitation(citation));
          }
        }
        break;
      }
      case "playbook-verdict":
        break;
      default:
        // Exhaustiveness: a new block kind must be handled explicitly.
        return unreachable(
          `Unhandled justification block kind: ${JSON.stringify(block)}`,
        );
    }
  }
  return resolved;
};

/**
 * Turn the documents an assistant answer referenced (its message
 * `sourceDocuments`) into export citations. A referenced document is a grounded
 * source, so each becomes a verified source line titled by the document. This
 * is the per-message provenance available today; the richer
 * {@link resolveExportCitations} path lights up once messages persist per-claim
 * justification blocks.
 */
export const sourceDocumentsToCitations = (
  sourceDocuments: readonly ChatSourceDocument[] | undefined,
  limit: number,
): ResolvedExportCitation[] => {
  const citations: ResolvedExportCitation[] = [];
  if (sourceDocuments === undefined) {
    return citations;
  }
  for (const document of sourceDocuments) {
    if (citations.length >= limit) {
      break;
    }
    const title = normalizeMarkdownSource(document.title);
    if (title.length === 0) {
      continue;
    }
    citations.push({ status: "verified", source: title });
  }
  return citations;
};

export type CitationSection = {
  /** Markdown appended to the message body; empty when there is nothing to
   *  render (no citations, or a de-duplicated set that produced no sources). */
  markdown: string;
  verifiedCount: number;
  unverifiedCount: number;
};

const EMPTY_SECTION: CitationSection = {
  markdown: "",
  verifiedCount: 0,
  unverifiedCount: 0,
};

type CitationCounts = { verifiedSources: string[]; unverifiedCount: number };

/** Split resolved citations into de-duplicated sources and an unverified tally.
 *  Duplicate source strings collapse so a memo never lists the same source
 *  twice. */
const tallyCitations = (
  citations: readonly ResolvedExportCitation[],
): CitationCounts => {
  const seen = new Set<string>();
  const verifiedSources: string[] = [];
  let unverifiedCount = 0;
  for (const citation of citations) {
    if (citation.status === "unverified") {
      unverifiedCount += 1;
      continue;
    }
    const source = citation.source.trim();
    if (source.length === 0 || seen.has(source)) {
      continue;
    }
    seen.add(source);
    verifiedSources.push(source);
  }
  return { verifiedSources, unverifiedCount };
};

const unverifiedNote = (count: number): string =>
  count === 1
    ? "1 citation could not be verified against a source and is omitted."
    : `${count} citations could not be verified against a source and are omitted.`;

/** Render verified sources as a numbered list under a "Sources" heading, with a
 *  trailing note when ungrounded citations were dropped. */
const renderFootnotesSection = (counts: CitationCounts): string => {
  const lines: string[] = [];
  if (counts.verifiedSources.length > 0) {
    lines.push(`## ${CHAT_EXPORT_SOURCES_HEADING}`, "");
    for (const [index, source] of counts.verifiedSources.entries()) {
      lines.push(`${index + 1}. ${source}`);
    }
  }
  if (counts.unverifiedCount > 0) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(`*${unverifiedNote(counts.unverifiedCount)}*`);
  }
  return lines.join("\n");
};

/** Render verified sources inline as one compact "Sources: …" paragraph. */
const renderInlineSection = (counts: CitationCounts): string => {
  const parts: string[] = [];
  if (counts.verifiedSources.length > 0) {
    parts.push(
      `**${CHAT_EXPORT_SOURCES_HEADING}:** ${counts.verifiedSources.join("; ")}`,
    );
  }
  if (counts.unverifiedCount > 0) {
    parts.push(
      `${CHAT_EXPORT_UNVERIFIED_MARKER} ${unverifiedNote(counts.unverifiedCount)}`,
    );
  }
  return parts.join(" ");
};

/**
 * Build the citation section for a chat export.
 *
 * `none` renders nothing. `footnotes` and `inline` both surface only grounded
 * sources; ungrounded citations are counted and summarised, never rendered as a
 * source. The `markdown` is appended to the message body before the shared
 * markdown -> DOCX renderer runs, so its headings/lists pick up semantic Word
 * styles like the rest of the document.
 */
export const buildCitationSection = (
  citations: readonly ResolvedExportCitation[],
  style: ChatExportCitationStyle,
): CitationSection => {
  if (style === "none") {
    return EMPTY_SECTION;
  }
  const counts = tallyCitations(citations);
  if (counts.verifiedSources.length === 0 && counts.unverifiedCount === 0) {
    return EMPTY_SECTION;
  }
  const markdown =
    style === "footnotes"
      ? renderFootnotesSection(counts)
      : renderInlineSection(counts);
  return {
    markdown,
    verifiedCount: counts.verifiedSources.length,
    unverifiedCount: counts.unverifiedCount,
  };
};
