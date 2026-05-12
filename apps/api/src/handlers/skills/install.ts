import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import type { SafeDb } from "@/api/db";
import { agentSkillResources, agentSkills } from "@/api/db/schema";
import type { AgentSkillOrigin, AgentSkillScope } from "@/api/db/schema";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createAuditContext,
  writeAuditLog,
} from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { PG_ERROR } from "@/api/lib/pg-error";

import type { ParsedSkillPackage } from "./skill-package";

type InstallSkillProps = {
  memberRole: { role: string };
  origin: AgentSkillOrigin;
  parsed: ParsedSkillPackage;
  request: Request;
  safeDb: SafeDb;
  scope: AgentSkillScope;
  server: {
    requestIP: (request: Request) => { address: string } | null;
  } | null;
  session: { activeOrganizationId: SafeId<"organization"> };
  user: { id: SafeId<"user"> };
};

export const installSkill = async ({
  memberRole,
  origin,
  parsed,
  request,
  safeDb,
  scope,
  server,
  session,
  user,
}: InstallSkillProps) => {
  if (scope === "team" && !["admin", "owner"].includes(memberRole.role)) {
    return Result.err(
      new HandlerError({
        status: 403,
        message: "Only admins and owners can install team skills",
      }),
    );
  }

  const userCount = await safeDb((tx) =>
    tx.$count(
      agentSkills,
      and(
        eq(agentSkills.organizationId, session.activeOrganizationId),
        eq(agentSkills.userId, user.id),
      ),
    ),
  );
  if (Result.isError(userCount)) {
    return Result.err(userCount.error);
  }
  if (userCount.value >= LIMITS.agentSkillsPerUser) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Skill limit reached for this user",
      }),
    );
  }

  const insertResult = await safeDb(
    async (tx) =>
      await tx.transaction(async (innerTx) => {
        const rows = await innerTx
          .insert(agentSkills)
          .values({
            organizationId: session.activeOrganizationId,
            userId: user.id,
            scope,
            origin,
            slug: parsed.name,
            name: parsed.name,
            description: parsed.description,
            version: parsed.version,
            license: parsed.license,
            compatibility: parsed.compatibility,
            metadata: parsed.metadata,
            sourceUrl: parsed.sourceUrl,
            contentHash: parsed.contentHash,
            body: parsed.body,
            enabled: true,
          })
          .returning({ id: agentSkills.id });

        const row = rows.at(0);
        if (!row) {
          return null;
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

        await writeAuditLog(
          {
            ...createAuditContext({
              organizationId: session.activeOrganizationId,
              userId: user.id,
              request,
              server,
            }),
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
                  slug: parsed.name,
                },
              },
            },
          },
          innerTx,
        );

        return { id: row.id };
      }),
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
    return Result.err(insertResult.error);
  }

  if (!insertResult.value) {
    return Result.err(
      new HandlerError({ status: 500, message: "Failed to install skill" }),
    );
  }

  return Result.ok(insertResult.value);
};
