import { panic, Result } from "better-result";

import type { SafeDb } from "@/api/db/safe-db";
import { CHAT_SKILL_SOURCE } from "@/api/lib/agent-skills/skills";
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

type SkillReadSurface =
  (typeof SKILL_READ_SURFACE)[keyof typeof SKILL_READ_SURFACE];

export const SKILL_READ_OUTCOME = {
  error: "error",
  success: "success",
} as const;

export type SkillReadOutcome =
  (typeof SKILL_READ_OUTCOME)[keyof typeof SKILL_READ_OUTCOME];

/** The skill a read names: its row, or a built-in, which has none. */
type SkillReadSubject =
  | { source: typeof CHAT_SKILL_SOURCE.installed; id: SafeId<"agentSkill"> }
  | { source: typeof CHAT_SKILL_SOURCE.builtIn };

type SkillReadAuditEventOptions = {
  outcome: SkillReadOutcome;
  /** The resource file read, or `null` for the skill's instructions. */
  path: string | null;
  skill: SkillReadSubject;
  slug: string;
  surface: SkillReadSurface;
};

/**
 * The one audit event for an agent reading a skill, whichever surface served
 * it. It names the skill and the file, never the content. A built-in has no
 * row, so its slug is the resource id; `skillSource` says which.
 */
const skillReadAuditEvent = ({
  outcome,
  path,
  skill,
  slug,
  surface,
}: SkillReadAuditEventOptions): AuditEvent => ({
  action: AUDIT_ACTION.ACCESS,
  resourceType: AUDIT_RESOURCE_TYPE.AGENT_SKILL,
  resourceId: skillReadResourceId({ skill, slug }),
  workspaceId: null,
  metadata: { outcome, path, skillSource: skill.source, slug, surface },
});

const skillReadResourceId = ({
  skill,
  slug,
}: {
  skill: SkillReadSubject;
  slug: string;
}): string => {
  switch (skill.source) {
    case CHAT_SKILL_SOURCE.installed:
      return skill.id;
    case CHAT_SKILL_SOURCE.builtIn:
      return slug;
    default: {
      skill satisfies never;
      return panic("skill read has an unknown source");
    }
  }
};

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
