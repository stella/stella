import { and, desc, eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { agentSkillRevisions } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

type LatestSkillRevisionOptions = {
  skillId: SafeId<"agentSkill">;
  organizationId: SafeId<"organization">;
  /**
   * Hold a share lock on the row for the rest of the transaction. Anything
   * that anchors to the revision (a proposal, a comment) takes it so the
   * revision trigger, which locks the latest row for update before
   * coalescing a save into it, serializes behind the anchor instead of
   * rewriting the body underneath it.
   */
  lock?: "share";
};

type LatestSkillRevision = {
  id: SafeId<"agentSkillRevision">;
  revisionNumber: number;
  body: string;
};

/**
 * The newest revision of a skill. Every skill has one: the
 * `record_agent_skill_revision` trigger writes revision 1 with the row itself.
 */
export const loadLatestSkillRevision = async (
  tx: Transaction,
  { skillId, organizationId, lock }: LatestSkillRevisionOptions,
): Promise<LatestSkillRevision | undefined> => {
  const query = tx
    .select({
      id: agentSkillRevisions.id,
      revisionNumber: agentSkillRevisions.revisionNumber,
      body: agentSkillRevisions.body,
    })
    .from(agentSkillRevisions)
    .where(
      and(
        eq(agentSkillRevisions.skillId, skillId),
        eq(agentSkillRevisions.organizationId, organizationId),
      ),
    )
    .orderBy(desc(agentSkillRevisions.revisionNumber))
    .limit(1);
  const rows = lock === "share" ? await query.for("share") : await query;

  return rows.at(0);
};
