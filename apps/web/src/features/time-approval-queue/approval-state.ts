import { panic } from "better-result";

import type {
  ApprovalEntry,
  ApprovalResult,
} from "@/features/time-approval-queue/queries";
import type { TranslationKey } from "@/i18n/types";

type ApprovalRefusal = Extract<ApprovalResult, { status: "refused" }>["reason"];
export const APPROVAL_REFUSAL_KEYS = {
  not_found: "billing.approvalQueue.refusals.not_found",
  not_approver: "billing.approvalQueue.refusals.not_approver",
  wrong_status: "billing.approvalQueue.refusals.wrong_status",
  running_timer: "billing.approvalQueue.refusals.running_timer",
  unpriced: "billing.approvalQueue.refusals.unpriced",
  time_period_locked: "billing.approvalQueue.refusals.time_period_locked",
  invalid_entry: "billing.approvalQueue.refusals.invalid_entry",
} as const satisfies Record<ApprovalRefusal, TranslationKey>;

type ApplyApprovalResultsOptions = {
  entries: ApprovalEntry[];
  selectedIds: string[];
  results: ApprovalResult[];
};
export const applyApprovalResults = ({
  entries,
  selectedIds,
  results,
}: ApplyApprovalResultsOptions) => {
  const approved = new Set(
    results
      .filter((result) => result.status === "approved")
      .map(({ id }) => id),
  );
  const selection = new Set(selectedIds);
  for (const result of results) {
    switch (result.status) {
      case "approved":
        selection.delete(result.id);
        break;
      case "refused":
        selection.add(result.id);
        break;
      default:
        result satisfies never;
        return panic("Unknown approval result");
    }
  }
  return {
    entries: entries.filter(({ id }) => !approved.has(id)),
    selectedIds: [...selection],
  };
};

export const RETURN_COMMENT_MAX_LENGTH = 2000;
export const validateReturnComment = (raw: string) => {
  const comment = raw.trim();
  if (comment.length === 0) {
    return {
      status: "invalid",
      key: "billing.approvalQueue.commentRequired",
    } as const;
  }
  if (comment.length > RETURN_COMMENT_MAX_LENGTH) {
    return {
      status: "invalid",
      key: "billing.approvalQueue.commentTooLong",
    } as const;
  }
  return { status: "valid", comment } as const;
};
