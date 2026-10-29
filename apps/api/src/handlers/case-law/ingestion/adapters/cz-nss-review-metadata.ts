import * as cheerio from "cheerio";

import {
  decisionDocketGrammarForJurisdiction,
  foldDecisionIdentifierInput,
  parseDecisionDocket,
} from "@stll/api-contract/decision-docket-grammar";

import { detectCitationDecisionDate } from "@/api/handlers/case-law/citation-decision-date";
import {
  canonicalCzechReviewCourt,
  type CzechAppealReview,
} from "@/api/handlers/case-law/ingestion/cz-appeal-reviews";
import {
  ownTableRows,
  visibleHtmlText,
} from "@/api/handlers/case-law/ingestion/parsers/shared-inlines";

const metadataOutcome = (value: string): CzechAppealReview["outcome"] => {
  const normalized = value.toLocaleLowerCase("cs");
  const reversed = /zrušen|změněn/u.test(normalized);
  const rejected = /zamítnut|odmítnut/u.test(normalized);
  if (/částečně|zčásti/u.test(normalized) || (reversed && rejected)) {
    return "partly";
  }
  if (reversed) {
    return "overturned";
  }
  if (/^(?:dosud\s+)?nerozhodnuto$/u.test(normalized.trim())) {
    return "pending";
  }
  return rejected ? "upheld" : "unknown";
};

export type CzNssPublisherReviewMetadata =
  | { status: "complete"; fields: Record<string, string> }
  | { status: "empty"; fields: Record<string, string> }
  | {
      status: "incomplete";
      reason: "missing_court" | "missing_case_number" | "invalid_case_number";
      fields: Record<string, string>;
    };

/** Each table row binds its court, reference, date and outcome together. */
export const parseCzNssPublisherReviewMetadata = (html: string) => {
  const $ = cheerio.load(html);
  const publisherReviews: CzechAppealReview[] = [];
  const publisherReviewMetadata: CzNssPublisherReviewMetadata[] = [];
  const rows = $("table")
    .toArray()
    .flatMap((table) => ownTableRows($(table)).toArray());
  for (const row of rows) {
    const cells = $(row).children("td, th").filter(".det-textval");
    if (
      cells.filter(
        '[data-field-id="kasacnistiznostoznacenivecivcelku"], [data-field-id="krajskysoud"]',
      ).length === 0
    ) {
      continue;
    }
    const fieldValues = new Map<string, string>();
    for (const cell of cells.toArray()) {
      const name = $(cell).attr("data-field-id");
      if (name !== undefined) {
        fieldValues.set(name, visibleHtmlText($(cell)));
      }
    }
    const fields = Object.fromEntries(fieldValues);
    const field = (name: string) =>
      fields[name]?.replace(/\s+/gu, " ").trim() ?? "";
    const reviewedCaseNumber = field("kasacnistiznostoznacenivecivcelku");
    const reviewedCourt = field("krajskysoud");
    // A rendered blank table row is a publisher placeholder, not a target.
    if (!reviewedCaseNumber && !reviewedCourt) {
      publisherReviewMetadata.push({ status: "empty", fields });
      continue;
    }
    if (!reviewedCourt) {
      publisherReviewMetadata.push({
        status: "incomplete",
        reason: "missing_court",
        fields,
      });
      continue;
    }
    if (!reviewedCaseNumber) {
      publisherReviewMetadata.push({
        status: "incomplete",
        reason: "missing_case_number",
        fields,
      });
      continue;
    }
    if (
      parseDecisionDocket(reviewedCaseNumber, {
        grammar: decisionDocketGrammarForJurisdiction("CZE"),
      }) === null
    ) {
      publisherReviewMetadata.push({
        status: "incomplete",
        reason: "invalid_case_number",
        fields,
      });
      continue;
    }
    publisherReviewMetadata.push({ status: "complete", fields });
    const context = ` ze dne ${field("datumrozhodnutikrajskehosoudu")}, č. j. `;
    publisherReviews.push({
      reviewedCaseNumber: foldDecisionIdentifierInput(reviewedCaseNumber),
      reviewedCourt: canonicalCzechReviewCourt(reviewedCourt),
      reviewedDecisionDate: detectCitationDecisionDate(context, context.length),
      outcome: metadataOutcome(field("rozhodnutonapkasst")),
    });
  }
  return { publisherReviews, publisherReviewMetadata };
};
