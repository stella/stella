import { STARTER_SKILLS } from "@stll/skills/starter-skills";

import type { Transaction } from "@/api/db/root";
import { agentSkills } from "@/api/db/schema";
import { hashSkillContent } from "@/api/lib/agent-skills/content-hash";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";

/** The body each starter skill is seeded with, by its slug. */
export const DEFAULT_SKILL_BODY_BY_SLUG: ReadonlyMap<string, string> = new Map(
  STARTER_SKILLS.map(({ body, slug }) => [slug, body]),
);

const DEFAULT_SKILL_SEED_SOURCE = "membership-created";

type SeedDefaultSkillsOptions = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  tx: Transaction;
};

/**
 * Installs the default skills for a new membership. Callers run it once, when
 * the membership is created, so defaults a member later deletes stay deleted.
 * A repeated call for the same member writes nothing: rows conflict on the
 * private (organization, user, slug) unique index.
 */
export const seedDefaultSkills = async ({
  organizationId,
  tx,
  userId,
}: SeedDefaultSkillsOptions): Promise<void> => {
  const rows = STARTER_SKILLS.map((skill) => ({
    id: createSafeId<"agentSkill">(),
    organizationId,
    userId,
    scope: "private" as const,
    origin: "default" as const,
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    metadata: {},
    contentHash: hashSkillContent({
      body: skill.body,
      compatibility: null,
      description: skill.description,
      license: null,
      metadata: {},
      name: skill.name,
      resources: [],
      version: null,
    }),
    body: skill.body,
    enabled: true,
    command: skill.command,
  }));

  const inserted = await tx
    .insert(agentSkills)
    .values(rows)
    .onConflictDoNothing()
    .returning({
      id: agentSkills.id,
      scope: agentSkills.scope,
      slug: agentSkills.slug,
      origin: agentSkills.origin,
      command: agentSkills.command,
    });

  const recordAuditEvent = createBackgroundAuditRecorder({
    organizationId,
    workspaceId: null,
    userId,
    execution: {
      performer: { type: "user", id: userId },
      trigger: { type: "system", source: DEFAULT_SKILL_SEED_SOURCE },
    },
  });
  await recordAuditEvent(
    tx,
    inserted.map(({ id, ...created }) => ({
      action: AUDIT_ACTION.CREATE,
      resourceType: AUDIT_RESOURCE_TYPE.AGENT_SKILL,
      resourceId: id,
      changes: { created: { old: null, new: created } },
      metadata: { seeded: true },
    })),
  );
};
