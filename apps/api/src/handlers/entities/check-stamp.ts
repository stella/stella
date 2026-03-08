import { and, desc, eq } from "drizzle-orm";
import { t, type Static } from "elysia";

import { db } from "@/api/db";
import { entities, entityVersions, workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { extractStamp, isStampableDocx } from "@/api/lib/docx-stamp";
import { FILE_SIZE_LIMITS } from "@/api/lib/limits";

export const checkStampBodySchema = t.Object({
  file: t.File({ maxSize: FILE_SIZE_LIMITS.document }),
});

type CheckStampHandlerProps = {
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
      extracted.verificationCode,
      organizationId,
    );
    if (match) {
      return { match };
    }
  }

  // Fallback: look up by stamp string (org-scoped)
  if (extracted.stamp) {
    const match = await lookupByStamp(extracted.stamp, organizationId);
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
  verificationCode: string,
  organizationId: SafeId<"organization">,
): Promise<StampMatch | null> => {
  const [row] = await db
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

const lookupByStamp = async (
  stamp: string,
  organizationId: SafeId<"organization">,
): Promise<StampMatch | null> => {
  const [row] = await db
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
