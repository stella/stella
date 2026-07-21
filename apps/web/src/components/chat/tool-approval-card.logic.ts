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
  isDocxEditBatch: boolean;
  isPublicOfficialApproval: boolean;
  name: ApprovalToolName;
};

export const hasAutomaticApproval = ({
  alwaysApprovedTools,
  canAlwaysAllow,
  conversationApprovedTools,
  isDocxEditBatch,
  isPublicOfficialApproval,
  name,
}: HasAutomaticApprovalOptions) =>
  !isNonPersistentGrantChatToolName(name) &&
  (isDocxEditBatch ||
    isPublicOfficialApproval ||
    isToolApprovedByGrant(conversationApprovedTools, name) ||
    (canAlwaysAllow && isToolApprovedByGrant(alwaysApprovedTools, name)));

/**
 * Stable discriminator for `edit_workspace_document`'s "no configured
 * author name" outcome -- mirrors
 * `EDIT_WORKSPACE_DOCUMENT_AUTHOR_NAME_REQUIRED_CODE` in
 * `apps/api/src/handlers/chat/tools/edit-workspace-document-tools.ts`
 * (redefined locally the same way `APPLY_ACTIVE_DOCX_EDITS_TOOL_NAME` is
 * redefined in `-queries.ts` -- a plain string literal, no shared runtime
 * logic to import across the apps/api - apps/web boundary).
 */
export const EDIT_WORKSPACE_DOCUMENT_AUTHOR_NAME_REQUIRED_CODE =
  "author_name_required";

export type EditWorkspaceDocumentOutcome =
  | { kind: "applied"; appliedCount: number; skippedCount: number }
  | { kind: "author-name-required"; message: string };

type EditWorkspaceDocumentOutputLike =
  | { success: true; applied: readonly unknown[]; skipped: readonly unknown[] }
  | { success: false; code: string; message: string };

/**
 * Turns `edit_workspace_document`'s completed-tool-call output into a
 * render-ready outcome for `ToolApprovalCard`'s result block. Returns
 * `null` for a failure code with no known UI treatment (there is
 * currently only the one -- author-name-required -- but every other
 * failure on this tool is a thrown `ChatToolError`, which never reaches
 * this shape at all, so `null` here is a defensive "render nothing"
 * rather than a case the backend is expected to produce today).
 */
export const describeEditWorkspaceDocumentOutcome = (
  output: EditWorkspaceDocumentOutputLike,
): EditWorkspaceDocumentOutcome | null => {
  if (output.success) {
    return {
      kind: "applied",
      appliedCount: output.applied.length,
      skippedCount: output.skipped.length,
    };
  }

  if (output.code !== EDIT_WORKSPACE_DOCUMENT_AUTHOR_NAME_REQUIRED_CODE) {
    return null;
  }

  return { kind: "author-name-required", message: output.message };
};
