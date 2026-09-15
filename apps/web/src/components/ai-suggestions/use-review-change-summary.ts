import { panic } from "better-result";
import { useTranslations } from "use-intl";

import type { ReviewChangeSummary } from "@/components/ai-suggestions/review-bar.logic";

/** A change summary in the reader's language. */
export const useReviewChangeSummary = (): ((
  summary: ReviewChangeSummary,
) => string) => {
  const t = useTranslations();
  return (summary) => {
    switch (summary.type) {
      case "text":
        return summary.text;
      case "deleteParagraphRange":
        return t("docxReview.summary.deleteParagraphRange", {
          first: summary.first,
          last: summary.last,
        });
      case "deleteParagraphs":
        return t("docxReview.summary.deleteParagraphs", {
          count: summary.count,
        });
      default:
        summary satisfies never;
        return panic(`Unhandled change summary: ${String(summary)}`);
    }
  };
};
