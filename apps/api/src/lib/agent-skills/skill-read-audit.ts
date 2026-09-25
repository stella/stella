import { Result } from "better-result";

import type { SafeDb } from "@/api/db/safe-db";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";

/** The agent surface that served a skill read. */
export const SKILL_READ_SURFACE = {
  chat: "chat",
  mcp: "mcp",
} as const;

export type SkillReadSurface =
  (typeof SKILL_READ_SURFACE)[keyof typeof SKILL_READ_SURFACE];

export const SKILL_READ_OUTCOME = {
  error: "error",
  success: "success",
} as const;

export type SkillReadOutcome =
  (typeof SKILL_READ_OUTCOME)[keyof typeof SKILL_READ_OUTCOME];

type SkillReadAuditEventOptions = {
  outcome: SkillReadOutcome;
  /** The resource file read, or `null` for the skill's instructions. */
  path: string | null;
  skillId: SafeId<"agentSkill">;
  slug: string;
  surface: SkillReadSurface;
};

/**
 * The one audit event for an agent reading a stored skill, whichever surface
 * served it. It names the skill and the file, never the content.
 */
export const skillReadAuditEvent = ({
  outcome,
  path,
  skillId,
  slug,
  surface,
}: SkillReadAuditEventOptions): AuditEvent => ({
  action: AUDIT_ACTION.ACCESS,
  resourceType: AUDIT_RESOURCE_TYPE.AGENT_SKILL,
  resourceId: skillId,
  workspaceId: null,
  metadata: { outcome, path, slug, surface },
});

type RecordSkillReadAuditOptions = {
  reads: readonly SkillReadAuditEventOptions[];
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
};

const SKILL_READ_AUDIT_SINK = failureSink({
  event: "skill_read_audit.write_failed",
  expected: [],
});

/**
 * Writes one skill-read audit event per read, in one statement. The reads
 * have already been served when this runs, so a failed write is captured
 * rather than turned into a failed read.
 */
export const recordSkillReadAudit = async ({
  reads,
  recordAuditEvent,
  safeDb,
}: RecordSkillReadAuditOptions): Promise<void> => {
  const result = await safeDb(
    async (tx) =>
      await recordAuditEvent(
        tx,
        reads.map((read) => skillReadAuditEvent(read)),
      ),
  );
  if (Result.isError(result)) {
    observeFailure(result.error, { sink: SKILL_READ_AUDIT_SINK });
  }
};
