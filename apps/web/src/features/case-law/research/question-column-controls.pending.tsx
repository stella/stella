import { Skeleton } from "@stll/ui/skeleton";

import { PendingText } from "@/components/pending-text";

/**
 * The question controls while the reader's questions are still being read:
 * the place the add button will take, held at its width. The results
 * toolbar's loading view draws the same face before its page is there.
 */
export const QuestionColumnControlsPending = ({
  label,
}: {
  label?: string | undefined;
}) => (
  <div aria-label={label} role="status">
    {label === undefined && (
      <span className="sr-only">
        <PendingText id="common.loading" />
      </span>
    )}
    <Skeleton className="h-7 w-32" />
  </div>
);
