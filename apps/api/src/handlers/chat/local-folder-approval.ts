import { Result } from "better-result";
import * as v from "valibot";

import {
  CHAT_LOCAL_RUN_REFUSAL,
  type ChatLocalFolderApproval,
} from "@stll/api-contract/chat-run-target";
import { DESKTOP_RUNNER_FEATURE_ID } from "@stll/api-contract/desktop-runner";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { loadFeatureAccessSnapshot } from "@/api/lib/auth/feature-access/context";
import type { DesktopRunnerControl } from "@/api/lib/desktop-runner/control";
import { getDesktopRunnerControl } from "@/api/lib/desktop-runner/runtime";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { isFeatureEnabled } from "@/api/lib/feature-access/policy";

const config = {
  contract: "patch",
  // Whoever may send a chat turn may let it work in their own folder.
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "assistant_chat" },
  params: v.object({
    desktopId: v.pipe(v.string(), v.uuid()),
    linkId: v.pipe(v.string(), v.uuid()),
  }),
} satisfies HandlerConfig;

type FolderApprovalDependencies = {
  control: () => Pick<DesktopRunnerControl, "approveLinkedFolder">;
};

const answer = (approval: ChatLocalFolderApproval) => Result.ok({ approval });

/**
 * The member's OK for chat turns to work in a folder they linked on one of
 * their computers, asked before the first turn there. It holds until the
 * folder is unlinked on the computer; linked again, it is asked again.
 * Idempotent.
 */
export const createApproveLocalFolder = (
  dependencies?: FolderApprovalDependencies,
) =>
  createSafeRootHandler(
    config,
    async function* ({
      params: { desktopId, linkId },
      recordAuditEvent,
      safeDb,
      session,
      user,
    }) {
      const owner = {
        userId: user.id,
        organizationId: session.activeOrganizationId,
      };
      const snapshot = yield* Result.await(
        loadFeatureAccessSnapshot({ safeDb, ...owner }),
      );
      if (!isFeatureEnabled(snapshot, DESKTOP_RUNNER_FEATURE_ID, owner)) {
        return Result.err(
          new HandlerError({
            status: 403,
            code: CHAT_LOCAL_RUN_REFUSAL.unavailable,
            message: "Running chat turns on a computer is not available.",
          }),
        );
      }
      const control =
        dependencies?.control() ?? getDesktopRunnerControl().control;
      // The approval and its audit event are one transaction.
      const approved = yield* Result.await(
        control.approveLinkedFolder({
          owner,
          desktopId,
          linkId,
          recordAuditEvent,
        }),
      );
      if (!approved) {
        return Result.err(
          new HandlerError({
            status: 409,
            code: CHAT_LOCAL_RUN_REFUSAL.folderUnavailable,
            message: "None of your computers lists that folder.",
          }),
        );
      }
      return answer("approved");
    },
  );

export default createApproveLocalFolder();
