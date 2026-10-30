import { requiresPerCallChatApproval } from "@stll/api-contract/chat-secret";
import { parseSuggestChangesInput } from "@stll/folio-agents";
import { FOLIO_DOCUMENT_OPERATION_TYPES } from "@stll/folio-core";

import { describeSuggestionChange } from "@/components/ai-suggestions/review-operation-labels";
import { summarizeOperation } from "@/components/ai-suggestions/review-suggestion-builder";
import {
  isApprovalOnceChatToolName,
  isToolApprovedByGrant,
} from "@/components/chat/chat-ui-tools";
import type {
  ApprovalToolName,
  ToolApprovalGrant,
} from "@/components/chat/chat-ui-tools";

type HasAutomaticApprovalOptions = {
  alwaysApprovedTools: ReadonlySet<ToolApprovalGrant>;
  canAlwaysAllow: boolean;
  conversationApprovedTools: ReadonlySet<ToolApprovalGrant>;
  name: ApprovalToolName;
};

export const hasAutomaticApproval = ({
  alwaysApprovedTools,
  canAlwaysAllow,
  conversationApprovedTools,
  name,
}: HasAutomaticApprovalOptions) =>
  !requiresPerCallChatApproval(name) &&
  !isApprovalOnceChatToolName(name) &&
  (isToolApprovedByGrant(conversationApprovedTools, name) ||
    (canAlwaysAllow && isToolApprovedByGrant(alwaysApprovedTools, name)));

/**
 * Stable discriminator for the server-executed `suggest_changes` variant's
 * "no configured author name" outcome -- mirrors
 * `SUGGEST_CHANGES_AUTHOR_NAME_REQUIRED_CODE` in
 * `apps/api/src/handlers/chat/tools/auto-apply-suggest-changes-tools.ts`
 * (a plain string literal, no shared runtime logic to import across the
 * apps/api - apps/web boundary).
 */
const SUGGEST_CHANGES_AUTHOR_NAME_REQUIRED_CODE = "author_name_required";

export type SuggestChangesApplyOutcome =
  | {
      kind: "applied";
      appliedCount: number;
      representation: "direct" | "tracked-changes";
      skippedCount: number;
    }
  | { kind: "author-name-required"; message: string };

type SuggestChangesApplyOutputLike =
  | {
      success: true;
      applied: readonly unknown[];
      representation: "direct" | "tracked-changes";
      skipped: readonly unknown[];
    }
  | { success: false; code: string; message: string };

/**
 * Turns the apply variant's completed-tool-call output into a render-ready
 * outcome for `ToolApprovalCard`'s result block. Returns `null` for a
 * failure code with no known UI treatment (there is currently only the one
 * -- author-name-required -- but every other failure on this tool is a
 * thrown `ChatToolError`, which never reaches this shape at all, so `null`
 * here is a defensive "render nothing" rather than a case the backend is
 * expected to produce today).
 */
export const describeSuggestChangesApplyOutcome = (
  output: SuggestChangesApplyOutputLike,
): SuggestChangesApplyOutcome | null => {
  if (output.success) {
    return {
      kind: "applied",
      appliedCount: output.applied.length,
      representation: output.representation,
      skippedCount: output.skipped.length,
    };
  }

  if (output.code !== SUGGEST_CHANGES_AUTHOR_NAME_REQUIRED_CODE) {
    return null;
  }

  return { kind: "author-name-required", message: output.message };
};

/** One proposed DOCX edit, as the approval card words it. */
export type ProposedDocxEdit = {
  /** The kind of change, worded by the review panel's own summary. */
  summary: string;
  /** The wording the edit puts in the document, when the summary does not quote it. */
  text: string | null;
};

// Every type, whatever the surface allowed: the card only words the call.
const DESCRIBABLE_OPERATIONS = {
  operationTypes: FOLIO_DOCUMENT_OPERATION_TYPES,
};

/**
 * Word the operations a `suggest_changes` call proposes, so the user approves
 * what will change rather than where folio stores it. Each operation is read
 * with folio's own parser, one at a time so a malformed one does not hide the
 * rest; one it cannot read is left out (the card's count still includes it).
 */
export const describeProposedDocxEdits = (
  operations: readonly unknown[],
): ProposedDocxEdit[] =>
  operations.flatMap((raw) => {
    const parsed = parseSuggestChangesInput(
      { operations: [raw] },
      DESCRIBABLE_OPERATIONS,
    );
    const operation = parsed.ok ? parsed.operations.at(0) : undefined;
    if (operation === undefined) {
      return [];
    }
    const change = describeSuggestionChange(operation);
    // A range replacement already quotes its new text in the summary.
    const text =
      change?.type === "text" && operation.type !== "replaceRange"
        ? change.text
        : null;
    return [{ summary: summarizeOperation(operation), text }];
  });
