// parser-output-unchanged: Declares guidance kinds, layouts and issuers; decision parsers reach it only through document-ast and write none of it.
/**
 * What a legal document is, who issued it, and which reader layout shows it.
 *
 * A court or an authority decides a case; an authority (and sometimes a
 * court) also issues guidance that decides none. Both are one `DocumentAst`,
 * told apart by its metadata, and the reader picks a layout from the kind
 * alone. The layout map is total over every kind, so a kind added here
 * without a layout is a type error rather than a document the reader lays out
 * by accident.
 */

import { panic } from "better-result";

import type { DocumentAstMetadata } from "./document-ast.js";

/**
 * The kinds of guidance an issuer publishes, as the soft-law corpus stores
 * them. This list is the source of truth for the corpus' `kind` column too.
 */
export const GUIDANCE_KINDS = [
  "methodology",
  "recommendation",
  "opinion",
  "faq",
  "guideline",
  "position",
  "statement",
  "inspection_report",
  "annual_report",
  "other",
] as const;

export type GuidanceKind = (typeof GUIDANCE_KINDS)[number];

export const DECISION_DOCUMENT_KIND = "decision";

export const DOCUMENT_KINDS = [
  DECISION_DOCUMENT_KIND,
  ...GUIDANCE_KINDS,
] as const;

export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/**
 * How the reader arranges a document. A decision opens with its caption and
 * operative part; an opinion is one body's reasoned view on a question put
 * to it; a guideline is a sectioned explanatory text with numbered
 * paragraphs; a recommendation is a short set of addressed points.
 */
export const DOCUMENT_LAYOUTS = [
  "decision",
  "opinion",
  "guideline",
  "recommendation",
] as const;

export type DocumentLayout = (typeof DOCUMENT_LAYOUTS)[number];

/**
 * The layout of every kind. An inspection report states findings about one
 * controller, so it reads like a decision; FAQs, methodologies and reports
 * are sectioned explanatory texts; `other` takes the generic sectioned
 * layout because nothing narrower is known about it.
 */
export const DOCUMENT_KIND_LAYOUTS = {
  decision: "decision",
  methodology: "guideline",
  recommendation: "recommendation",
  opinion: "opinion",
  faq: "guideline",
  guideline: "guideline",
  position: "opinion",
  statement: "guideline",
  inspection_report: "decision",
  annual_report: "guideline",
  other: "guideline",
} as const satisfies Record<DocumentKind, DocumentLayout>;

/**
 * Who issued a document. A court and an authority are different readers'
 * questions (an authority is party to the regulation it explains), so the
 * branch is structure, not a label to parse back out of the name.
 */
export const DOCUMENT_ISSUER_TYPES = ["court", "authority"] as const;

export type DocumentIssuerType = (typeof DOCUMENT_ISSUER_TYPES)[number];

export type DocumentIssuer = {
  type: DocumentIssuerType;
  /** The issuer's name, as the publisher prints it. */
  name: string;
  /** ISO 3166-1 alpha-3 code, or `EU` for a Union body. */
  jurisdiction: string;
};

export const documentKindOf = (metadata: DocumentAstMetadata): DocumentKind => {
  switch (metadata.type) {
    case undefined:
    case "decision": {
      return DECISION_DOCUMENT_KIND;
    }
    case "guidance": {
      return metadata.kind;
    }
    default: {
      metadata satisfies never;
      return panic(`Unhandled document metadata: ${String(metadata)}`);
    }
  }
};

export const documentLayoutOf = (
  metadata: DocumentAstMetadata,
): DocumentLayout => DOCUMENT_KIND_LAYOUTS[documentKindOf(metadata)];
