import { useTranslations } from "use-intl";

import { Skeleton } from "@stll/ui/skeleton";

/**
 * The question controls while the reader's questions are still being read:
 * the place the add button will take, held at its width. The results
 * toolbar's loading view draws the same face before its page is there.
 */
export const QuestionColumnControlsPending = () => {
  const t = useTranslations();

  return (
    <div role="status" aria-label={t("common.loading")}>
      <Skeleton className="h-7 w-32" />
    </div>
  );
};
