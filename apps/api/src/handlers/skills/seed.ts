import { Result } from "better-result";
import { and, eq, isNotNull } from "drizzle-orm";

import { agentSkills } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";

// Default slash-command skills installed for every new user. They
// mirror the legacy `prompt_shortcuts` defaults — same commands, same
// bodies — but live in `agent_skills` so the unified surface treats
// them like any other authored skill.
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

const config = {
  permissions: { agentSkill: ["create"] },
} satisfies HandlerConfig;

const hashBody = (body: string): string =>
  new Bun.CryptoHasher("sha256").update(body).digest("hex").slice(0, 64);

const seedSkills = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user, recordAuditEvent }) {
    // Authored skills with a command are this surface's primary
    // hand-rolled artefact. Skip if the user already owns any in
    // *this* org so a returning user doesn't get the defaults
    // re-seeded after deleting them. Scoping by `organizationId` is
    // required: skill rows are per-org, and a user who switches
    // organizations should still get defaults in the new one.
    const existing = yield* Result.await(
      safeDb((tx) =>
        tx.$count(
          agentSkills,
          and(
            eq(agentSkills.organizationId, session.activeOrganizationId),
            eq(agentSkills.userId, user.id),
            eq(agentSkills.origin, "authored"),
            isNotNull(agentSkills.command),
          ),
        ),
      ),
    );

    if (existing > 0) {
      return Result.ok({ seeded: false });
    }

    yield* Result.await(
      safeDb(async (tx) => {
        const seedRows = DEFAULT_SKILLS.map((skill) => ({
          id: createSafeId<"agentSkill">(),
          organizationId: session.activeOrganizationId,
          userId: user.id,
          scope: "private" as const,
          origin: "authored" as const,
          slug: `${skill.command}-default`,
          name: skill.name,
          description: skill.description,
          metadata: {},
          contentHash: hashBody(skill.body),
          body: skill.body,
          enabled: true,
          command: skill.command,
          autoInvokeHint: null,
        }));

        const insertedRows = await tx
          .insert(agentSkills)
          .values(seedRows)
          // Defensive in case two clients race the seed; the
          // existence check above is the primary gate.
          .onConflictDoNothing()
          .returning({ id: agentSkills.id, slug: agentSkills.slug });

        // Audit only what we actually wrote — a racing concurrent
        // seed could have inserted the same rows first, in which case
        // `onConflictDoNothing` returns nothing and a CREATE event
        // for a non-existent resource id would corrupt the trail.
        const insertedBySlug = new Map(
          insertedRows.map((row) => [row.slug, row.id] as const),
        );
        const auditEntries = seedRows.flatMap((row) => {
          const insertedId = insertedBySlug.get(row.slug);
          if (!insertedId) {
            return [];
          }
          return [
            {
              action: AUDIT_ACTION.CREATE,
              resourceType: AUDIT_RESOURCE_TYPE.AGENT_SKILL,
              resourceId: insertedId,
              changes: {
                created: {
                  old: null,
                  new: {
                    scope: row.scope,
                    slug: row.slug,
                    origin: row.origin,
                    command: row.command,
                  },
                },
              },
              metadata: { seeded: true },
            },
          ];
        });
        if (auditEntries.length > 0) {
          await recordAuditEvent(tx, auditEntries);
        }
      }),
    );

    return Result.ok({ seeded: true });
  },
);

export default seedSkills;
