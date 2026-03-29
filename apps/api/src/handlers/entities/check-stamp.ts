import { and, desc, eq } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { ScopedDb } from "@/api/db";
import { entities, entityVersions, workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { createHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { extractStamp, isStampableDocx } from "@/api/lib/docx-stamp";
import { FILE_SIZE_LIMITS } from "@/api/lib/limits";

export const checkStampBodySchema = t.Object({
  file: t.File({ maxSize: FILE_SIZE_LIMITS.document }),
});

type CheckStampHandlerProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  body: Static<typeof checkStampBodySchema>;
};

/**
 * Check if an uploaded DOCX contains a Stella stamp and
 * resolve it to an existing entity within the user's org.
 *
 * Returns match info for the frontend to offer "update
 * existing" vs "upload as new" options.
 */
export const checkStampHandler = async ({
  scopedDb,
  organizationId,
  body: { file },
}: CheckStampHandlerProps) => {
  if (!isStampableDocx(file.type, file.size)) {
    return { match: null };
  }

  const buffer = await file.arrayBuffer();
  const extracted = await extractStamp(buffer);

  if (!extracted.verificationCode && !extracted.stamp) {
    return { match: null };
  }

  // Primary: look up by verification code (globally unique,
  // then scoped to org for security)
  if (extracted.verificationCode) {
    const match = await lookupByVerificationCode(
      scopedDb,
      extracted.verificationCode,
      organizationId,
    );
    if (match) {
      return { match };
    }
  }

  // Fallback: look up by stamp string (org-scoped)
  if (extracted.stamp) {
    const match = await lookupByStamp(
      scopedDb,
      extracted.stamp,
      organizationId,
    );
    if (match) {
      return { match };
    }
  }

  return { match: null };
};

type StampMatch = {
  entityId: string;
  entityName: string | null;
  workspaceId: string;
  workspaceName: string;
  stamp: string;
  versionNumber: number;
};

const lookupByVerificationCode = async (
  scopedDb: ScopedDb,
  verificationCode: string,
  organizationId: SafeId<"organization">,
): Promise<StampMatch | null> => {
  const rows = await scopedDb((tx) =>
    tx
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
      .limit(1),
  );
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
  };
};

const config = {
  permissions: { workspace: ["read"] },
  body: checkStampBodySchema,
} satisfies HandlerConfig;

const checkStamp = createHandler(
  config,
  async ({ scopedDb, session, body }) =>
    await checkStampHandler({
      scopedDb,
      organizationId: session.activeOrganizationId,
      body,
    }),
);

export default checkStamp;

const lookupByStamp = async (
  scopedDb: ScopedDb,
  stamp: string,
  organizationId: SafeId<"organization">,
): Promise<StampMatch | null> => {
  const rows = await scopedDb((tx) =>
    tx
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
      .limit(1),
  );
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
  };
};
