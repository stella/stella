/**
 * The claim a reviewer comments on, read under the caller's matter scope.
 * A comment is a reader annotation on the claim's own words: its one span is
 * the claim's anchor in the pinned document text, so the comment points at
 * the same passage the verification underlined.
 */

import { panic } from "better-result";
import { and, eq } from "drizzle-orm";

import {
  READER_ANNOTATION_QUOTE_MAX_LENGTH,
  readerPdfPageAnchorId,
} from "@stll/api-contract/legal-reader-annotations";

import type { Transaction } from "@/api/db/root";
import { legalListClaims } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { ClaimAnchor } from "@/api/lib/lists/verification/contract";

type CommentedClaim = {
  anchor: ClaimAnchor;
  text: string;
};

/**
 * The claim, if the caller can see it in this matter: the claim's row
 * policies (matter access, the verification's feature fence) decide, so a
 * claim of another matter or organization reads as absent.
 */
export const readCommentedClaim = async ({
  claimId,
  runId,
  tx,
  workspaceId,
}: {
  claimId: SafeId<"legalListClaim">;
  runId: SafeId<"legalListVerificationRun">;
  tx: Pick<Transaction, "select">;
  workspaceId: SafeId<"workspace">;
}): Promise<CommentedClaim | undefined> =>
  (
    await tx
      .select({ anchor: legalListClaims.anchor, text: legalListClaims.text })
      .from(legalListClaims)
      .where(
        and(
          eq(legalListClaims.id, claimId),
          eq(legalListClaims.runId, runId),
          eq(legalListClaims.workspaceId, workspaceId),
        ),
      )
      .limit(1)
  ).at(0);

/** The anchor id a claim's block carries in the reader: a DOCX block's own
 *  id, or the page for a PDF. */
const anchorBlockId = (anchor: ClaimAnchor): string => {
  switch (anchor.type) {
    case "docx-block": {
      return anchor.blockId;
    }
    case "pdf-page": {
      return readerPdfPageAnchorId(anchor.pageNumber);
    }
    default: {
      anchor satisfies never;
      return panic(`Unhandled claim anchor: ${String(anchor)}`);
    }
  }
};

/**
 * The claim's words as an annotation quote: whole when they fit, cut at a
 * code point boundary when the claim is longer than a quote may be.
 */
export const claimQuote = (text: string): string => {
  let quote = "";
  for (const codePoint of text) {
    if (quote.length + codePoint.length > READER_ANNOTATION_QUOTE_MAX_LENGTH) {
      break;
    }
    quote += codePoint;
  }
  return quote;
};

/**
 * The one span a comment on this claim covers. A claim's comment is found
 * by its claim, not by its words in a document, so it keeps no context.
 */
export const claimCommentSpan = (claim: CommentedClaim) => ({
  blockAnchorId: anchorBlockId(claim.anchor),
  endOffset: claim.anchor.end,
  quote: claimQuote(claim.text),
  quotePrefix: "",
  quoteSuffix: "",
  startOffset: claim.anchor.start,
});
