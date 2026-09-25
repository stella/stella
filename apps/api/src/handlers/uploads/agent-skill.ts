/**
 * `agent_skill` purpose: presigned-upload flow that ends in an
 * installed `agentSkills` row + companion `agentSkillResources`, the
 * same install the multipart endpoint at
 * `apps/api/src/handlers/skills/upload.ts` runs.
 *
 * `validateAgentSkill` enforces the same team-scope admin/owner check
 * as the multipart endpoint.
 */
import { Result, panic } from "better-result";
import { and, eq } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import {
  pendingUploads,
  type PendingUploadFinalizedResult,
} from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import {
  authorizeSkillInstallScope,
  installSkill,
} from "@/api/lib/skills/install";
import { parseUploadedSkillPackage } from "@/api/lib/skills/skill-package";
import { finalizeErr, finalizeOk } from "@/api/lib/uploads/runtime";

export type ValidateAgentSkillProps = {
  memberRole: { role: string };
  scope: "team" | "private";
};

/**
 * The install scope check is pure (no DB), so it also runs at presign
 * time: the API does not mint a URL for an upload the user can't
 * legitimately finalize.
 *
 * @returns the authorization result.
 */
export const validateAgentSkill = ({
  memberRole,
  scope,
}: ValidateAgentSkillProps) => {
  const authorization = authorizeSkillInstallScope({ memberRole, scope });
  if (Result.isError(authorization)) {
    return Result.err(authorization.error);
  }
  return Result.ok(undefined);
};

export type FinalizeAgentSkillProps = {
  safeDb: SafeDb;
  recordAuditEvent: AuditRecorder;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  memberRole: { role: string };
  scanned: ScannedFile;
  scope: "team" | "private";
  uploadId: SafeId<"pendingUpload">;
  claimRequestId: string;
  workspaceId: SafeId<"workspace">;
};

/**
 * Domain transaction for `agent_skill`: parses the scanned ZIP /
 * markdown into a `ParsedSkillPackage`, then runs `installSkill`,
 * which handles user-limit, slug-uniqueness, resource fan-out, and
 * the audit row.
 *
 * Skill rows do not have an S3 backing object: the skill body and
 * resources are inlined into DB columns. The generic upload runtime
 * verifies and scans the staged bytes, then this finalizer installs
 * the skill and marks the pending-upload row inside the same
 * transaction.
 *
 * @yields safeDb errors out to the parent safe-handler.
 */
// oxlint-disable-next-line require-yield -- yields shape is provided by `installSkill`'s safeDb returns; nothing yields here directly
export const finalizeAgentSkill = async function* ({
  safeDb,
  recordAuditEvent,
  organizationId,
  userId,
  memberRole,
  scanned,
  scope,
  uploadId,
  claimRequestId,
  workspaceId,
}: FinalizeAgentSkillProps) {
  // The archive size has already been bounded by the presign-time
  // `FILE_SIZE_LIMIT_BYTES.skillPack` check.
  const parsed = await parseUploadedSkillPackage(scanned);
  if (Result.isError(parsed)) {
    return finalizeErr({
      status: parsed.error.status === 500 ? 500 : 422,
      message: parsed.error.message,
      rejectReason: "skill-package-parse-failed",
    });
  }

  const installResult = await installSkill({
    memberRole,
    onInstalled: async (tx, skill) => {
      const finalized: Extract<
        PendingUploadFinalizedResult,
        { type: "agent_skill" }
      > = {
        type: "agent_skill",
        skillId: skill.id,
        name: parsed.value.name,
        version: parsed.value.version ?? "",
      };

      // audit: skip — final FSM transition on pending_uploads;
      // the agent-skill audit row is recorded by installSkill in this transaction.
      const finalizedRows = await tx
        .update(pendingUploads)
        .set({
          status: "finalized",
          finalizedResult: finalized,
          finalizedAt: new Date(),
        })
        .where(
          and(
            eq(pendingUploads.id, uploadId),
            eq(pendingUploads.userId, userId),
            eq(pendingUploads.workspaceId, workspaceId),
            eq(pendingUploads.status, "scanning"),
            eq(pendingUploads.claimedByRequestId, claimRequestId),
          ),
        )
        .returning({ id: pendingUploads.id });
      if (!finalizedRows.at(0)) {
        panic("Pending upload finalize marker update returned no rows");
      }
    },
    origin: "upload",
    parsed: parsed.value,
    recordAuditEvent,
    safeDb,
    scope,
    session: { activeOrganizationId: organizationId },
    user: { id: userId },
  });
  if (installResult.status === "error") {
    const error = installResult.error;
    const status = (() => {
      if (!(error instanceof HandlerError)) {
        return 500 as const;
      }
      switch (error.status) {
        case 400:
        case 404:
        case 409:
        case 422:
        case 500:
          return error.status;
        case 401:
        case 402:
        case 403:
        case 413:
        case 428:
        case 429:
        case 502:
        case 503:
          return 500 as const;
        default:
          return panic("Unsupported skill upload error status");
      }
    })();
    return finalizeErr({
      status,
      message: error.message,
      rejectReason: "skill-install-failed",
    });
  }

  const finalized: Extract<
    PendingUploadFinalizedResult,
    { type: "agent_skill" }
  > = {
    type: "agent_skill",
    skillId: installResult.value.id,
    name: parsed.value.name,
    version: parsed.value.version ?? "",
  };

  // The audit row is emitted inside `installSkill` against the
  // newly created agentSkills row, so no extra audit call here.
  return finalizeOk({ finalizedResult: finalized, afterPromote: undefined });
};
