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

// Slash-command skills every member starts with, as private skills of their
// own in the organization they join.
const DEFAULT_SKILLS = [
  {
    name: "Summarise a document",
    description: "Get a structured summary of the key terms",
    command: "summarize",
    body: "Summarise this document. Cover parties, key obligations, dates, financial terms, and any termination or liability provisions.",
  },
  {
    name: "Find risks",
    description: "Spot legal risks and ambiguous clauses",
    command: "risks",
    body: "Review this document for legal risks, missing protections, and ambiguous clauses. Cite the specific clause for each finding.",
  },
  {
    name: "Compare versions",
    description: "List every material change between two versions",
    command: "compare",
    body: "Compare two versions of this document and list every material change with its location.",
  },
  {
    name: "Draft a response",
    description: "Draft a professional reply to a letter",
    command: "draft",
    body: "Draft a measured response to this letter. Keep the tone professional, address each point raised, and flag any open questions for me to confirm.",
  },
] as const;

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
  const rows = DEFAULT_SKILLS.map((skill) => ({
    id: createSafeId<"agentSkill">(),
    organizationId,
    userId,
    scope: "private" as const,
    origin: "authored" as const,
    slug: `${skill.command}-default`,
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
