import {
  isNonPersistentGrantChatToolName,
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
  isPublicOfficialApproval: boolean;
  name: ApprovalToolName;
};

export const hasAutomaticApproval = ({
  alwaysApprovedTools,
  canAlwaysAllow,
  conversationApprovedTools,
  isPublicOfficialApproval,
  name,
}: HasAutomaticApprovalOptions) =>
  !isNonPersistentGrantChatToolName(name) &&
  (isPublicOfficialApproval ||
    isToolApprovedByGrant(conversationApprovedTools, name) ||
    (canAlwaysAllow && isToolApprovedByGrant(alwaysApprovedTools, name)));

/**
 * Stable discriminator for the server-executed `suggest_changes` variant's
 * "no configured author name" outcome -- mirrors
 * `SUGGEST_CHANGES_AUTHOR_NAME_REQUIRED_CODE` in
 * `apps/api/src/handlers/chat/tools/auto-apply-suggest-changes-tools.ts`
 * (a plain string literal, no shared runtime logic to import across the
 * apps/api - apps/web boundary).
 */
export const SUGGEST_CHANGES_AUTHOR_NAME_REQUIRED_CODE = "author_name_required";

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
