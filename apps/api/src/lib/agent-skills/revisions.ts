import { and, desc, eq, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { agentSkillRevisions } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

type LatestSkillRevisionOptions = {
  skillId: SafeId<"agentSkill">;
  organizationId: SafeId<"organization">;
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
  { skillId, organizationId }: LatestSkillRevisionOptions,
): Promise<LatestSkillRevision | undefined> => {
  const rows = await tx
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

  return rows.at(0);
};

/**
 * Keep saves out of a skill until this transaction ends. Anything that anchors
 * to a revision (a proposal, a comment) takes it before reading the revision:
 * the revision trigger coalesces a save into the latest revision only while
 * nothing references it, and every save updates the skill row this locks. The
 * database function checks the caller can see the skill and refuses otherwise.
 */
export const lockSkillForAnchor = async (
  tx: Transaction,
  skillId: SafeId<"agentSkill">,
): Promise<void> => {
  await tx.execute(sql`SELECT lock_agent_skill_for_anchor(${skillId})`);
};
