import { Result } from "better-result";
import { and, desc, eq } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb } from "@/api/db";
import { entities, entityVersions, workspaces } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { extractStamp, isStampableDocx } from "@/api/lib/docx-stamp";
import { FILE_SIZE_LIMITS } from "@/api/lib/limits";

const checkStampBodySchema = t.Object({
  file: t.File({ maxSize: FILE_SIZE_LIMITS.document }),
});

type CheckStampHandlerProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  body: Static<typeof checkStampBodySchema>;
};

/**
 * Check if an uploaded DOCX contains a Stella stamp and
 * resolve it to an existing entity within the user's org.
 *
 * Returns match info for the frontend to offer "update
 * existing" vs "upload as new" options.
 *
 * @yields {Err} on database lookup failure
 */
const checkStampHandler = async function* ({
  safeDb,
  organizationId,
  body: { file },
}: CheckStampHandlerProps) {
  const noMatch: CheckStampResult = { match: null };

  if (!isStampableDocx(file.type, file.size)) {
    return Result.ok(noMatch);
  }

  const buffer = await file.arrayBuffer();
  const extracted = await extractStamp(buffer);

  if (!extracted.verificationCode && !extracted.stamp) {
    return Result.ok(noMatch);
  }

  // Primary: look up by verification code (globally unique,
  // then scoped to org for security)
  if (extracted.verificationCode) {
    const match = yield* Result.await(
      lookupByVerificationCode(
        safeDb,
        extracted.verificationCode,
        organizationId,
      ),
    );
    if (match) {
      const found: CheckStampResult = { match };
      return Result.ok(found);
    }
  }

  // Fallback: look up by stamp string (org-scoped)
  if (extracted.stamp) {
    const match = yield* Result.await(
      lookupByStamp(safeDb, extracted.stamp, organizationId),
    );
    if (match) {
      const found: CheckStampResult = { match };
      return Result.ok(found);
    }
  }

  return Result.ok(noMatch);
};

type StampMatch = {
  entityId: string;
  entityName: string | null;
  workspaceId: string;
  workspaceName: string;
  stamp: string;
  versionNumber: number;
};

type CheckStampResult = { match: StampMatch | null };

const lookupByVerificationCode = async (
  safeDb: SafeDb,
  verificationCode: string,
  organizationId: SafeId<"organization">,
) =>
  await safeDb(async (tx) => {
    const rows = await tx
      .select({
        entityId: entities.id,
        entityName: entities.name,
        workspaceId: workspaces.id,
        workspaceName: workspaces.name,
        stamp: entityVersions.stamp,
        versionNumber: entityVersions.versionNumber,
      })
      .from(entityVersions)
      .innerJoin(entities, eq(entityVersions.entityId, entities.id))
      .innerJoin(
        workspaces,
        and(
          eq(entities.workspaceId, workspaces.id),
          eq(workspaces.organizationId, organizationId),
        ),
      )
      .where(eq(entityVersions.verificationCode, verificationCode))
      .limit(1);
    const row = rows.at(0);

    if (!row || !row.stamp) {
      return null;
    }

    return {
      entityId: row.entityId,
      entityName: row.entityName,
      workspaceId: row.workspaceId,
      workspaceName: row.workspaceName,
      stamp: row.stamp,
      versionNumber: row.versionNumber,
    } satisfies StampMatch;
  });

const config = {
  permissions: { workspace: ["read"] },
  body: checkStampBodySchema,
} satisfies HandlerConfig;

const checkStamp = createSafeHandler(
  config,
  async function* ({ safeDb, session, body }) {
    return yield* checkStampHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      body,
    });
  },
);

export default checkStamp;

const lookupByStamp = async (
  safeDb: SafeDb,
  stamp: string,
  organizationId: SafeId<"organization">,
) =>
  await safeDb(async (tx) => {
    const rows = await tx
      .select({
        entityId: entities.id,
        entityName: entities.name,
        workspaceId: workspaces.id,
        workspaceName: workspaces.name,
        stamp: entityVersions.stamp,
        versionNumber: entityVersions.versionNumber,
      })
      .from(entityVersions)
      .innerJoin(entities, eq(entityVersions.entityId, entities.id))
      .innerJoin(
        workspaces,
        and(
          eq(entities.workspaceId, workspaces.id),
          eq(workspaces.organizationId, organizationId),
        ),
      )
      .where(eq(entityVersions.stamp, stamp))
      .orderBy(desc(entityVersions.createdAt))
      .limit(1);
    const row = rows.at(0);

    if (!row || !row.stamp) {
      return null;
    }

    return {
      entityId: row.entityId,
      entityName: row.entityName,
      workspaceId: row.workspaceId,
      workspaceName: row.workspaceName,
      stamp: row.stamp,
      versionNumber: row.versionNumber,
    } satisfies StampMatch;
  });
