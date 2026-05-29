/**
 * `agent_skill` purpose: presigned-upload flow that ends in an
 * installed `agentSkills` row + companion `agentSkillResources`,
 * mirroring the legacy multipart endpoint at
 * `apps/api/src/handlers/skills/upload.ts`.
 *
 * Unlike entity_create / entity_version, agent_skill uploads are
 * root-scoped (no `workspaceId`). The pending_uploads row carries
 * `workspace_id IS NULL` and `organization_*_root` RLS policies
 * gate access. `validateAgentSkill` enforces the team-scope
 * admin/owner check the legacy handler runs.
 */
import { Result } from "better-result";

import type { SafeDb } from "@/api/db";
import type { PendingUploadFinalizedResult } from "@/api/db/schema";
import {
  authorizeSkillInstallScope,
  installSkill,
} from "@/api/handlers/skills/install";
import { parseUploadedSkillPackage } from "@/api/handlers/skills/skill-package";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import { finalizeErr, finalizeOk } from "./lib";

export type ValidateAgentSkillProps = {
  memberRole: { role: string };
  scope: "team" | "private";
};

/**
 * The legacy handler's scope check is pure (no DB), so we reuse it
 * verbatim. Returning early at presign time keeps the API from
 * minting a URL for an upload the user can't legitimately finalize.
 *
 * @yields nothing — pure check.
 */
// eslint-disable-next-line require-yield -- generator shape matches the dispatch contract
export const validateAgentSkill = async function* ({
  memberRole,
  scope,
}: ValidateAgentSkillProps) {
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
  fileBuffer: ArrayBuffer;
  declaredName: string;
  declaredMime: string;
  scope: "team" | "private";
};

/**
 * Domain transaction for `agent_skill`: parses the uploaded ZIP /
 * markdown into a `ParsedSkillPackage`, then runs the legacy
 * `installSkill` path which handles user-limit, slug-uniqueness,
 * resource fan-out, and the audit row.
 *
 * The skill rows do not have an S3 backing object (the skill body
 * + resources are inlined into the DB columns), so the
 * "finalKey" we return is a synthetic placeholder. The
 * upload-runtime still copies the tmp object to it, then
 * lifecycle-cleans because no consumer reads from there — phase 6
 * can drop the copy for skill uploads if the bookkeeping becomes
 * meaningful.
 *
 * @yields safeDb errors out to the parent safe-handler.
 */
// eslint-disable-next-line require-yield -- yields shape is provided by `installSkill`'s safeDb returns; nothing yields here directly
export const finalizeAgentSkill = async function* ({
  safeDb,
  recordAuditEvent,
  organizationId,
  userId,
  memberRole,
  fileBuffer,
  declaredName,
  declaredMime,
  scope,
}: FinalizeAgentSkillProps) {
  // parseUploadedSkillPackage takes a File; wrap the buffer back
  // into one. The legacy handler's parsing is identical; the
  // archive size has already been bounded by the presign-time
  // `FILE_SIZE_LIMIT_BYTES.skillPack` check.
  const file = new File([fileBuffer], declaredName, {
    type: declaredMime || "application/octet-stream",
  });
  const parsed = await parseUploadedSkillPackage(file);
  if (Result.isError(parsed)) {
    return finalizeErr({
      status: parsed.error.status === 500 ? 500 : 422,
      message: parsed.error.message,
      rejectReason: "skill-package-parse-failed",
    });
  }

  const installResult = await installSkill({
    memberRole,
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
        default:
          return 500 as const;
      }
    })();
    return finalizeErr({
      status,
      message: error.message ?? "Failed to install skill",
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

  // Synthetic key — the skill body lives in the DB; nothing reads
  // from this. We still issue the server-side copy so the finalize
  // runtime's invariant ("scanned-passed bytes always promote to a
  // non-tmp/ key") holds across purposes.
  const finalKey = `agent-skills/${organizationId}/${installResult.value.id}.archive`;

  // The audit row is emitted inside `installSkill` against the
  // newly created agentSkills row, so no extra audit call here.
  void recordAuditEvent;
  void AUDIT_ACTION;
  void AUDIT_RESOURCE_TYPE;

  return finalizeOk({ finalizedResult: finalized, finalKey });
};
