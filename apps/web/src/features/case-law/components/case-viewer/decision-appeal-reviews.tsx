import { useTranslations } from "use-intl";

import {
  createCaseLawDecisionPath,
  createCaseLawDecisionRouteParams,
} from "@stll/api-contract/case-law-decision-route";
import type {
  DecisionReviewLink,
  DecisionReviews,
} from "@stll/api-contract/case-law-reviews";
import { sanitizeHref } from "@stll/decision-reader/sanitize-href";
import { BidiText } from "@stll/ui/bidi-text";
import { ReviewStatusBadge } from "@stll/ui/review-status-badge";
import type { ReviewStatusTone } from "@stll/ui/review-status-badge";

import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import { formatDecisionDate } from "@/lib/decision-date";

const STATUS_LABEL = {
  upheld: "caseLaw.viewer.appealReviews.upheld",
  overturned: "caseLaw.viewer.appealReviews.overturned",
  partly: "caseLaw.viewer.appealReviews.partly",
  under_review: "caseLaw.viewer.appealReviews.underReview",
  pending: "caseLaw.viewer.appealReviews.underReview",
  unknown: "caseLaw.viewer.appealReviews.unknown",
  none_found: "caseLaw.viewer.appealReviews.noneFound",
} as const satisfies Record<
  DecisionReviews["status"] | DecisionReviewLink["outcome"],
  TranslationKey
>;

const SOURCE_LABEL = {
  metadata: "caseLaw.viewer.appealReviews.sourceMetadata",
  opening: "caseLaw.viewer.appealReviews.sourceOpening",
  history: "caseLaw.viewer.appealReviews.sourceHistory",
} as const satisfies Record<DecisionReviewLink["source"], TranslationKey>;

const STATUS_TONE = {
  upheld: "neutral",
  overturned: "warning",
  partly: "warning",
  under_review: "neutral",
  pending: "neutral",
  unknown: "neutral",
  none_found: "neutral",
} as const satisfies Record<
  DecisionReviews["status"] | DecisionReviewLink["outcome"],
  ReviewStatusTone
>;

type DecisionAppealReviewsProps = {
  reviews: DecisionReviews;
  country: string;
};

/** Procedural review evidence stays distinct from the authority citator. */
export const DecisionAppealReviews = ({
  reviews,
  country,
}: DecisionAppealReviewsProps) => {
  const t = useTranslations();
  const format = useFormatter();
  type ReviewLinkOptions = { id: string; caseNumber: string; court: string };
  const link = ({ id, caseNumber, court }: ReviewLinkOptions) =>
    createCaseLawDecisionPath(
      createCaseLawDecisionRouteParams({
        caseNumber,
        country,
        court,
        decisionId: id,
        slug: null,
        language: null,
        languageAlternates: null,
      }),
    );
  const hasConflict = [...reviews.reviewedBy, ...reviews.reviews].some(
    ({ evidenceStatus }) => evidenceStatus === "conflict",
  );
  if (country !== "CZE") {
    return null;
  }
  return (
    <section
      aria-label={t("caseLaw.viewer.appealReviews.title")}
      className="reader-chrome flex flex-col gap-2 text-sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-foreground-strong-muted text-xs font-medium">
          {t("caseLaw.viewer.appealReviews.title")}
        </h2>
        <ReviewStatusBadge tone={STATUS_TONE[reviews.status]}>
          {t(STATUS_LABEL[reviews.status])}
        </ReviewStatusBadge>
      </div>
      {hasConflict && (
        <p className="text-warning-foreground text-xs">
          {t("caseLaw.viewer.appealReviews.conflict")}
        </p>
      )}
      {reviews.status === "none_found" && (
        <p className="text-muted-foreground text-xs">
          {t("caseLaw.viewer.appealReviews.corpusOnly")}
        </p>
      )}
      {reviews.reviewedBy.length > 0 && (
        <div>
          <h3 className="text-muted-foreground text-xs">
            {t("caseLaw.viewer.appealReviews.reviewedBy")}
          </h3>
          <ul>
            {reviews.reviewedBy.map((review) => (
              <li
                key={`${review.reviewingDecisionId}:${review.reviewedCourt}:${review.reviewedCaseNumber}:${review.reviewedDecisionDate ?? "unknown"}`}
                className="flex flex-wrap items-center gap-2"
              >
                <a
                  href={sanitizeHref(
                    link({
                      id: review.reviewingDecisionId,
                      caseNumber: review.reviewingCaseNumber,
                      court: review.reviewingCourt,
                    }),
                  )}
                  className="inline-flex min-h-11 items-center underline underline-offset-4"
                >
                  <BidiText>{review.reviewingCaseNumber}</BidiText>
                </a>
                <ReviewStatusBadge
                  tone={
                    STATUS_TONE[
                      review.evidenceStatus === "conflict"
                        ? "unknown"
                        : review.outcome
                    ]
                  }
                >
                  {t(
                    STATUS_LABEL[
                      review.evidenceStatus === "conflict"
                        ? "unknown"
                        : review.outcome
                    ],
                  )}
                </ReviewStatusBadge>
                <span className="text-muted-foreground text-xs">
                  {t(SOURCE_LABEL[review.source])}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {reviews.reviews.length > 0 && (
        <div>
          <h3 className="text-muted-foreground text-xs">
            {t("caseLaw.viewer.appealReviews.reviews")}
          </h3>
          <ul>
            {reviews.reviews.map((review) => (
              <li
                key={`${review.reviewedCourt}:${review.reviewedCaseNumber}:${review.reviewedDecisionDate ?? "unknown"}`}
                className="flex flex-wrap items-center gap-2"
              >
                {review.reviewedDecisionId === null ? (
                  <span className="inline-flex flex-wrap items-baseline gap-2">
                    <BidiText>{review.reviewedCourt}</BidiText>
                    <BidiText>{review.reviewedCaseNumber}</BidiText>
                    {review.reviewedDecisionDate !== null && (
                      <time dateTime={review.reviewedDecisionDate}>
                        {formatDecisionDate(
                          review.reviewedDecisionDate,
                          format,
                        )}
                      </time>
                    )}
                  </span>
                ) : (
                  <a
                    href={sanitizeHref(
                      link({
                        id: review.reviewedDecisionId,
                        caseNumber: review.reviewedCaseNumber,
                        court: review.reviewedCourt,
                      }),
                    )}
                    className="inline-flex min-h-11 items-center underline underline-offset-4"
                  >
                    <BidiText>{review.reviewedCaseNumber}</BidiText>
                  </a>
                )}
                <ReviewStatusBadge
                  tone={
                    STATUS_TONE[
                      review.evidenceStatus === "conflict"
                        ? "unknown"
                        : review.outcome
                    ]
                  }
                >
                  {t(
                    STATUS_LABEL[
                      review.evidenceStatus === "conflict"
                        ? "unknown"
                        : review.outcome
                    ],
                  )}
                </ReviewStatusBadge>
                <span className="text-muted-foreground text-xs">
                  {t(SOURCE_LABEL[review.source])}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {(reviews.reviewedByTruncated || reviews.reviewsTruncated) && (
        <p className="text-muted-foreground text-xs">
          {t("caseLaw.viewer.appealReviews.truncated")}
        </p>
      )}
    </section>
  );
};
