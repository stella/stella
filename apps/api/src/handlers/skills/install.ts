import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { agentSkillResources, agentSkills } from "@/api/db/schema";
import type { AgentSkillOrigin, AgentSkillScope } from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { PG_ERROR } from "@/api/lib/pg-error";

import type { ParsedSkillPackage } from "./skill-package";

type InstallSkillProps = {
  allowUnchangedUrlReplay?: boolean;
  // Install as a draft (hidden until the user finishes). Defaults to true so
  // existing upload/import callers keep installing enabled skills.
  enabled?: boolean;
  memberRole: { role: string };
  onInstalled?: (
    tx: Transaction,
    skill: { id: SafeId<"agentSkill"> },
  ) => Promise<void>;
  origin: AgentSkillOrigin;
  parsed: ParsedSkillPackage;
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  scope: AgentSkillScope;
  session: { activeOrganizationId: SafeId<"organization"> };
  // Override the stored slug. Defaults to the parsed name (the package's own
  // identifier). Callers that instantiate the same package repeatedly (e.g.
  // blueprints) pass a unique slug to avoid (org, scope, slug) collisions.
  slug?: string;
  user: { id: SafeId<"user"> };
};

type InstallSkillTransactionResult =
  | { id: SafeId<"agentSkill">; type: "installed" }
  | { id: SafeId<"agentSkill">; type: "unchanged" }
  | { type: "conflict" }
  | { type: "insert-failed" }
  | { type: "limit-reached" }
  | { type: "team-limit-reached" };

export const installSkill = async ({
  allowUnchangedUrlReplay = false,
  enabled = true,
  memberRole,
  onInstalled,
  origin,
  parsed,
  recordAuditEvent,
  safeDb,
  scope,
  session,
  slug,
  user,
}: InstallSkillProps) => {
  const authorization = authorizeSkillInstallScope({ memberRole, scope });
  if (Result.isError(authorization)) {
    return Result.err(authorization.error);
  }

  const insertResult = await safeDb(
    async (tx) =>
      await tx.transaction(
        async (innerTx): Promise<InstallSkillTransactionResult> => {
          const existingSkill = async () => {
            if (!allowUnchangedUrlReplay) {
              return undefined;
            }
            const rows = await innerTx
              .select({
                contentHash: agentSkills.contentHash,
                id: agentSkills.id,
                origin: agentSkills.origin,
                sourceUrl: agentSkills.sourceUrl,
              })
              .from(agentSkills)
              .where(
                and(
                  eq(agentSkills.organizationId, session.activeOrganizationId),
                  eq(agentSkills.scope, scope),
                  eq(agentSkills.slug, slug ?? parsed.name),
                  scope === "private"
                    ? eq(agentSkills.userId, user.id)
                    : undefined,
                ),
              )
              .limit(1);
            return rows.at(0);
          };
          const unchangedSkill = async () => {
            const existing = await existingSkill();
            return existing && isUnchangedUrlSkill({ existing, origin, parsed })
              ? existing
              : undefined;
          };
          const unchangedBeforeInsert = await unchangedSkill();
          if (unchangedBeforeInsert) {
            return { id: unchangedBeforeInsert.id, type: "unchanged" };
          }

          const userCount = await innerTx.$count(
            agentSkills,
            and(
              eq(agentSkills.organizationId, session.activeOrganizationId),
              eq(agentSkills.userId, user.id),
            ),
          );
          if (userCount >= LIMITS.agentSkillsPerUser) {
            return { type: "limit-reached" };
          }

          // Team skills are org-wide visible in the chat skill catalogue; cap
          // them per-org too (not just per-user) so the catalogue cannot grow
          // past agentSkillsChatMetadataMax and silently hide skills.
          if (scope === "team") {
            const teamCount = await innerTx.$count(
              agentSkills,
              and(
                eq(agentSkills.organizationId, session.activeOrganizationId),
                eq(agentSkills.scope, "team"),
              ),
            );
            if (teamCount >= LIMITS.agentSkillsTeamPerOrganization) {
              return { type: "team-limit-reached" };
            }
          }

          const insert = innerTx.insert(agentSkills).values({
            organizationId: session.activeOrganizationId,
            userId: user.id,
            scope,
            origin,
            slug: slug ?? parsed.name,
            name: parsed.name,
            description: parsed.description,
            version: parsed.version,
            license: parsed.license,
            compatibility: parsed.compatibility,
            metadata: parsed.metadata,
            sourceUrl: parsed.sourceUrl,
            contentHash: parsed.contentHash,
            body: parsed.body,
            enabled,
          });
          const rows = allowUnchangedUrlReplay
            ? await insert
                .onConflictDoNothing()
                .returning({ id: agentSkills.id })
            : await insert.returning({ id: agentSkills.id });

          const row = rows.at(0);
          if (!row) {
            if (allowUnchangedUrlReplay) {
              const unchangedAfterConflict = await unchangedSkill();
              return unchangedAfterConflict
                ? { id: unchangedAfterConflict.id, type: "unchanged" }
                : { type: "conflict" };
            }
            return { type: "insert-failed" };
          }

          if (parsed.resources.length > 0) {
            await innerTx.insert(agentSkillResources).values(
              parsed.resources.map((resource) => ({
                organizationId: session.activeOrganizationId,
                skillId: row.id,
                path: resource.path,
                kind: resource.kind,
                content: resource.content,
                sizeBytes: resource.sizeBytes,
              })),
            );
          }

          await recordAuditEvent(innerTx, {
            action: AUDIT_ACTION.CREATE,
            resourceType: AUDIT_RESOURCE_TYPE.AGENT_SKILL,
            resourceId: row.id,
            changes: {
              created: {
                old: null,
                new: {
                  contentHash: parsed.contentHash,
                  origin,
                  resourceCount: parsed.resources.length,
                  scope,
                  slug: slug ?? parsed.name,
                },
              },
            },
          });
          await onInstalled?.(innerTx, { id: row.id });

          return { id: row.id, type: "installed" };
        },
      ),
  );

  if (Result.isError(insertResult)) {
    if (
      DatabaseError.is(insertResult.error) &&
      insertResult.error.code === PG_ERROR.UNIQUE_VIOLATION
    ) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: `A skill named "${parsed.name}" already exists`,
        }),
      );
    }
    return Result.err(
      new HandlerError({
        status: 500,
        message: "Failed to install skill",
        cause: insertResult.error,
      }),
    );
  }

  if (insertResult.value.type === "limit-reached") {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Skill limit reached for this user",
      }),
    );
  }

  if (insertResult.value.type === "team-limit-reached") {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Team skill limit reached for this organization",
      }),
    );
  }

  if (insertResult.value.type === "insert-failed") {
    return Result.err(
      new HandlerError({ status: 500, message: "Failed to install skill" }),
    );
  }

  if (insertResult.value.type === "conflict") {
    return Result.err(
      new HandlerError({
        status: 409,
        message: `A skill named "${parsed.name}" already exists`,
      }),
    );
  }

  return Result.ok({ id: insertResult.value.id });
};

export const isUnchangedUrlSkill = ({
  existing,
  origin,
  parsed,
}: {
  existing: Pick<
    typeof agentSkills.$inferSelect,
    "contentHash" | "origin" | "sourceUrl"
  >;
  origin: AgentSkillOrigin;
  parsed: Pick<ParsedSkillPackage, "contentHash" | "sourceUrl">;
}): boolean =>
  origin === "url" &&
  existing.origin === "url" &&
  parsed.sourceUrl !== null &&
  existing.sourceUrl === parsed.sourceUrl &&
  existing.contentHash === parsed.contentHash;

export const authorizeSkillInstallScope = ({
  memberRole,
  scope,
}: {
  memberRole: { role: string };
  scope: AgentSkillScope;
}): Result<void, HandlerError> => {
  if (scope !== "team" || ["admin", "owner"].includes(memberRole.role)) {
    return Result.ok(undefined);
  }

  return Result.err(
    new HandlerError({
      status: 403,
      message: "Only admins and owners can install team skills",
    }),
  );
};
