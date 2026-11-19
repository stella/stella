import * as v from "valibot";

import { legalResolveResponseSchema } from "@stll/api-contract/legal-resolve";

import { DECISION_REVIEWS_PROJECTION } from "./decision-review-projection";
import {
  passthroughId,
  projectionBranch,
  publicUrl,
} from "./projection-fields";
import { unenumeratedJsonList } from "./projection-schema";

// --- resolve_case_law_decision / resolve_law_citation -------------------------
// Both tools answer the shared legal resolve envelope. The projection spreads
// the contract's own branches and annotates only the public corpus handles
// (decision and statute document ids) and the reader links, which embed
// those ids; every other field is the contract's schema.

const [resolved, notFound, ambiguous, incomplete, countryUnavailable] =
  legalResolveResponseSchema.options;
const [decisionDocument, provisionDocument] = resolved.entries.document.options;
const [readableText, withheldText, unavailableText] =
  decisionDocument.entries.text.options;
const [coverageRead, coverageUnavailable] =
  notFound.entries.coverage.wrapped.options;
const [notPublished, incompleteListing, notReconciled] =
  coverageRead.entries.sources.item.options;

const candidate = v.strictObject({
  ...ambiguous.entries.candidates.item.entries,
  decisionId: passthroughId(),
  readerUrl: publicUrl(),
});

const otherCourtCandidates = v.optional(
  v.array(
    v.strictObject({
      ...resolved.entries.otherCourtCandidates.wrapped.item.entries,
      decisionId: passthroughId(),
      readerUrl: publicUrl(),
    }),
  ),
);

const decision = v.strictObject({
  ...decisionDocument.entries,
  decisionId: passthroughId(),
  languageAlternates: v.array(
    v.strictObject({
      ...decisionDocument.entries.languageAlternates.item.entries,
      decisionId: passthroughId(),
    }),
  ),
  readerUrl: publicUrl(),
  text: v.variant("status", [
    projectionBranch(readableText),
    projectionBranch(withheldText),
    projectionBranch(unavailableText),
  ]),
  appealReviews: DECISION_REVIEWS_PROJECTION,
});

const provision = v.strictObject({
  ...provisionDocument.entries,
  documentId: passthroughId(),
  readerUrl: publicUrl(),
  // The contract leaves the preview blocks opaque; the provision preview
  // reader bounds them (32 blocks of `{ id, anchorId, text }`).
  blocks: unenumeratedJsonList(),
});

const coverage = v.optional(
  v.variant("status", [
    projectionBranch(
      v.strictObject({
        ...coverageRead.entries,
        sources: v.array(
          v.variant("verdict", [
            projectionBranch(notPublished),
            projectionBranch(incompleteListing),
            projectionBranch(notReconciled),
          ]),
        ),
      }),
    ),
    projectionBranch(coverageUnavailable),
  ]),
);

/**
 * resolve_case_law_decision and resolve_law_citation. Source of truth:
 * `legalResolveResponseSchema`, which both handlers (`legal-resolve-tools.ts`)
 * answer unchanged. Every id is a public corpus id, so the chat payload is
 * the MCP payload.
 */
export const LEGAL_RESOLVE_PROJECTION = v.variant("status", [
  projectionBranch(
    v.strictObject({
      ...resolved.entries,
      document: v.variant("kind", [
        projectionBranch(decision),
        projectionBranch(provision),
      ]),
      otherCourtCandidates,
    }),
  ),
  projectionBranch(
    v.strictObject({ ...notFound.entries, otherCourtCandidates, coverage }),
  ),
  projectionBranch(
    v.strictObject({
      ...ambiguous.entries,
      candidates: v.array(candidate),
      otherCourtCandidates,
    }),
  ),
  projectionBranch(
    v.strictObject({ ...incomplete.entries, otherCourtCandidates }),
  ),
  projectionBranch(countryUnavailable),
]);

// --- verify_quote --------------------------------------------------------------

const quoteTextSource = v.picklist(["ast", "fulltext"]);

const quotePassage = {
  // UTF-16 offsets into the stored text, which address the whole stored span
  // even where `text` was cut at its byte bound.
  start: v.number(),
  end: v.number(),
  text: v.string(),
  paragraphs: v.array(
    v.strictObject({
      position: v.number(),
      label: v.nullable(v.string()),
      headingPath: v.array(v.string()),
      url: v.exactOptional(publicUrl()),
    }),
  ),
} as const;

/**
 * verify_quote. Source of truth: `verifyQuoteOutputSchema`
 * (`verify-quote-tools.ts`), whose declared bounds the handler enforces before
 * the answer leaves it: at most 20 occurrences per segment and 32 paragraphs
 * per passage. The decision id is a public corpus id and the paragraph links
 * are reader links, so the chat payload is the MCP payload.
 */
export const VERIFY_QUOTE_PROJECTION = v.variant("status", [
  projectionBranch(
    v.strictObject({
      status: v.literal("exact"),
      verified: v.literal(true),
      decisionId: passthroughId(),
      textSource: quoteTextSource,
      segments: v.array(
        v.strictObject({
          text: v.string(),
          occurrenceCount: v.number(),
          occurrences: v.array(v.strictObject(quotePassage)),
        }),
      ),
    }),
  ),
  projectionBranch(
    v.strictObject({
      status: v.literal("cannot_verify"),
      verified: v.literal(false),
      decisionId: passthroughId(),
      textState: v.picklist([
        "pending",
        "unavailable",
        "withheld",
        "failed",
        "empty",
      ]),
      hint: v.string(),
    }),
  ),
  projectionBranch(
    v.strictObject({
      status: v.picklist(["fuzzy", "not_found"]),
      verified: v.literal(false),
      decisionId: passthroughId(),
      textSource: quoteTextSource,
      segments: v.array(
        v.strictObject({
          text: v.string(),
          closest: v.nullable(
            v.strictObject({
              ...quotePassage,
              similarity: v.number(),
              differences: v.array(
                v.strictObject({
                  type: v.picklist(["equal", "added", "dropped"]),
                  words: v.array(v.string()),
                }),
              ),
            }),
          ),
        }),
      ),
    }),
  ),
]);
