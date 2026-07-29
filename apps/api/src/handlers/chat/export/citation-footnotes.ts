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

import type { UiLocale } from "@stll/locales";

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

type ChatExportCitationLabels = {
  citation: string;
  locale: UiLocale;
  sources: string;
  unverifiedCitationsOmitted: string;
};

const CHAT_EXPORT_CITATION_LABELS = {
  ar: {
    citation: "استشهاد",
    sources: "المصادر",
    unverifiedCitationsOmitted: "تم حذف الاستشهادات غير المتحقق منها",
  },
  cs: {
    citation: "Citace",
    sources: "Zdroje",
    unverifiedCitationsOmitted: "Vynechané neověřené citace",
  },
  de: {
    citation: "Quellenangabe",
    sources: "Quellen",
    unverifiedCitationsOmitted: "Ausgelassene nicht verifizierte Zitate",
  },
  en: {
    citation: "Citation",
    sources: "Sources",
    unverifiedCitationsOmitted: "Unverified citations omitted",
  },
  es: {
    citation: "Cita",
    sources: "Fuentes",
    unverifiedCitationsOmitted: "Citas no verificadas omitidas",
  },
  et: {
    citation: "Viide",
    sources: "Allikad",
    unverifiedCitationsOmitted: "Välja jäetud kontrollimata viited",
  },
  fr: {
    citation: "Citation",
    sources: "Sources",
    unverifiedCitationsOmitted: "Citations non vérifiées omises",
  },
  hu: {
    citation: "Hivatkozás",
    sources: "Források",
    unverifiedCitationsOmitted: "Kihagyott, nem ellenőrzött hivatkozások",
  },
  lt: {
    citation: "Citata",
    sources: "Šaltiniai",
    unverifiedCitationsOmitted: "Praleistos nepatvirtintos citatos",
  },
  lv: {
    citation: "Atsauce",
    sources: "Avoti",
    unverifiedCitationsOmitted: "Izlaistas nepārbaudītas atsauces",
  },
  pl: {
    citation: "Cytowanie",
    sources: "Źródła",
    unverifiedCitationsOmitted: "Pominięte niezweryfikowane cytowania",
  },
  "pt-BR": {
    citation: "Citação",
    sources: "Fontes",
    unverifiedCitationsOmitted: "Citações não verificadas omitidas",
  },
  sk: {
    citation: "Citácia",
    sources: "Zdroje",
    unverifiedCitationsOmitted: "Vynechané neoverené citácie",
  },
} satisfies Record<UiLocale, Omit<ChatExportCitationLabels, "locale">>;

export const getChatExportCitationLabels = (
  locale: UiLocale,
): ChatExportCitationLabels => ({
  locale,
  ...CHAT_EXPORT_CITATION_LABELS[locale],
});

const DEFAULT_CITATION_LABELS = getChatExportCitationLabels("en");

/** A citation resolved for export: either a grounded source (which becomes a
 *  numbered/inline source entry) or an ungrounded marker that carries NO
 *  source text. */
export type ResolvedExportCitation =
  | { status: "verified"; source: string; sourceId: string }
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
  fileFieldId: string,
  fileName: string | undefined,
): ResolvedExportCitation => {
  const locator = `${citation.bates} (p. ${citation.pageNumber})`;
  return {
    status: "verified",
    source: fileName ? `${fileName}, ${locator}` : locator,
    sourceId: `pdf-bates:${fileFieldId}:${citation.bates}:${citation.pageNumber}`,
  };
};

/** A grounded `docx-folio` quote carries the block text; an unverified one
 *  carries only the model's hint, so it never becomes a source. */
const resolveDocxFolioCitation = (
  citation: DocxFolioJustificationCitation,
): ResolvedExportCitation => {
  if (citation.citationStatus === "unverified") {
    return { status: "unverified" };
  }
  return {
    status: "verified",
    source: citation.text,
    sourceId: `docx-folio:${citation.blockId}`,
  };
};

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
            resolved.push(
              resolvePdfBatesCitation(citation, block.fileFieldId, fileName),
            );
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
  const seen = new Set<string>();
  if (sourceDocuments === undefined) {
    return citations;
  }
  for (const document of sourceDocuments) {
    const title = normalizeMarkdownSource(document.title);
    if (title.length === 0) {
      continue;
    }
    const sourceId = `document:${document.workspaceId ?? "organization"}:${document.entityId}`;
    if (seen.has(sourceId)) {
      continue;
    }
    if (citations.length >= limit) {
      break;
    }
    seen.add(sourceId);
    citations.push({
      status: "verified",
      source: title,
      sourceId,
    });
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
  const uniqueSources: { source: string; sourceId: string }[] = [];
  let unverifiedCount = 0;
  for (const citation of citations) {
    if (citation.status === "unverified") {
      unverifiedCount += 1;
      continue;
    }
    const source = citation.source.trim();
    if (source.length === 0 || seen.has(citation.sourceId)) {
      continue;
    }
    seen.add(citation.sourceId);
    uniqueSources.push({ source, sourceId: citation.sourceId });
  }
  const sourceCounts = new Map<string, number>();
  for (const { source } of uniqueSources) {
    sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
  }
  const sourceOrdinals = new Map<string, number>();
  const verifiedSources = uniqueSources.map(({ source }) => {
    const count = sourceCounts.get(source);
    if (count === undefined || count === 1) {
      return source;
    }
    const ordinal = (sourceOrdinals.get(source) ?? 0) + 1;
    sourceOrdinals.set(source, ordinal);
    return `${source} (${ordinal})`;
  });
  return { verifiedSources, unverifiedCount };
};

const unverifiedNote = (
  count: number,
  labels: ChatExportCitationLabels,
): string =>
  `${labels.unverifiedCitationsOmitted}: ${new Intl.NumberFormat(
    labels.locale,
  ).format(count)}`;

/** Render verified sources as a numbered list under a "Sources" heading, with a
 *  trailing note when ungrounded citations were dropped. */
const renderFootnotesSection = (
  counts: CitationCounts,
  labels: ChatExportCitationLabels,
): string => {
  const lines: string[] = [];
  if (counts.verifiedSources.length > 0) {
    lines.push(`## ${labels.sources}`, "");
    for (const [index, source] of counts.verifiedSources.entries()) {
      lines.push(`${index + 1}. ${source}`);
    }
  }
  if (counts.unverifiedCount > 0) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(`*${unverifiedNote(counts.unverifiedCount, labels)}*`);
  }
  return lines.join("\n");
};

/** Render verified sources inline as one compact "Sources: …" paragraph. */
const renderInlineSection = (
  counts: CitationCounts,
  labels: ChatExportCitationLabels,
): string => {
  const parts: string[] = [];
  if (counts.verifiedSources.length > 0) {
    parts.push(`**${labels.sources}:** ${counts.verifiedSources.join("; ")}`);
  }
  if (counts.unverifiedCount > 0) {
    parts.push(unverifiedNote(counts.unverifiedCount, labels));
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
  labels: ChatExportCitationLabels = DEFAULT_CITATION_LABELS,
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
      ? renderFootnotesSection(counts, labels)
      : renderInlineSection(counts, labels);
  return {
    markdown,
    verifiedCount: counts.verifiedSources.length,
    unverifiedCount: counts.unverifiedCount,
  };
};
