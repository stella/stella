import { useState } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Input } from "@stll/ui/input";

import type {
  ReviewTarget,
  TimeReview,
} from "@/features/time-review/use-time-review";

/**
 * Returns the checked entries to their owners together, with one reason,
 * in one request per bounded batch. Shown only while entries are checked.
 */
export const ReturnSelected = ({
  review,
  selected,
}: {
  review: TimeReview;
  selected: readonly ReviewTarget[];
}) => {
  const t = useTranslations();
  const [comment, setComment] = useState("");
  if (selected.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        aria-label={t("billing.approval.returnComment")}
        className="max-w-72"
        onChange={(event) => setComment(event.target.value)}
        placeholder={t("billing.approval.returnComment")}
        value={comment}
      />
      <Button
        disabled={comment.trim() === ""}
        loading={selected.some(({ id }) => review.isPending(id))}
        onClick={() => review.returnToDraft(selected, comment)}
        size="sm"
        variant="outline"
      >
        {t("billing.approval.returnSelected", { count: selected.length })}
      </Button>
    </div>
  );
};
