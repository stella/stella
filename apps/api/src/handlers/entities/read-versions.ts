import { Result } from "better-result";
import { and, desc, eq } from "drizzle-orm";
import { t } from "elysia";

import type { SafeDb } from "@/api/db";
import { desktopEditSessions, entityVersions } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const readVersionsParamsSchema = workspaceParams({ entityId: t.String() });

type ReadVersionsHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  entityId: string;
};

const readVersionsHandler = async function* ({
  safeDb,
  workspaceId,
  entityId,
}: ReadVersionsHandlerProps) {
  // Validate entity exists in workspace and get entity-level author
  const entity = yield* Result.await(
    safeDb((tx) =>
      tx.query.entities.findFirst({
        where: {
          id: entityId,
          workspaceId: { eq: workspaceId },
        },
        columns: {
          id: true,
          name: true,
          kind: true,
          createdBy: true,
          currentVersionId: true,
        },
      }),
    ),
  );

  if (!entity) {
    return Result.err(
      new HandlerError({ status: 404, message: "Entity not found" }),
    );
  }

  // Fetch all versions with their file fields, author from desktop edit
  // sessions (for v2+), and user info
  const [versionsResult, sessionsResult] = await Promise.all([
    safeDb((tx) =>
      tx
        .select({
          id: entityVersions.id,
          versionNumber: entityVersions.versionNumber,
          stamp: entityVersions.stamp,
          label: entityVersions.label,
          description: entityVersions.description,
          diffWordsAdded: entityVersions.diffWordsAdded,
          diffWordsRemoved: entityVersions.diffWordsRemoved,
          createdBy: entityVersions.createdBy,
          createdAt: entityVersions.createdAt,
        })
        .from(entityVersions)
        .where(
          and(
            eq(entityVersions.entityId, entityId),
            eq(entityVersions.workspaceId, workspaceId),
          ),
        )
        .orderBy(desc(entityVersions.versionNumber)),
    ),
    // Get finalized sessions to map version → author
    safeDb((tx) =>
      tx
        .select({
          finalizedVersionId: desktopEditSessions.finalizedVersionId,
          createdBy: desktopEditSessions.createdBy,
        })
        .from(desktopEditSessions)
        .where(
          and(
            eq(desktopEditSessions.entityId, entityId),
            eq(desktopEditSessions.workspaceId, workspaceId),
            eq(desktopEditSessions.status, "finalized"),
          ),
        ),
    ),
  ]);

  const versions = yield* versionsResult;
  const sessions = yield* sessionsResult;

  // Build session author lookup: versionId → userId
  const sessionAuthorMap = new Map<string, string>();
  for (const s of sessions) {
    if (s.finalizedVersionId) {
      sessionAuthorMap.set(s.finalizedVersionId, s.createdBy);
    }
  }

  // Collect all unique author user IDs.
  // Priority: version.createdBy > session author > entity.createdBy
  const authorUserIds = new Set<string>();
  for (const v of versions) {
    if (v.createdBy) {
      authorUserIds.add(v.createdBy);
    } else {
      const sessionAuthor = sessionAuthorMap.get(v.id);
      if (sessionAuthor) {
        authorUserIds.add(sessionAuthor);
      }
    }
  }
  if (entity.createdBy) {
    authorUserIds.add(entity.createdBy);
  }

  // Fetch all author user details in one query
  const authorUsers =
    authorUserIds.size > 0
      ? yield* Result.await(
          safeDb((tx) =>
            tx.query.user.findMany({
              where: { id: { in: [...authorUserIds] } },
              columns: { id: true, name: true, image: true },
            }),
          ),
        )
      : [];

  const userMap = new Map(authorUsers.map((u) => [u.id, u]));

  // Fetch file fields for all versions
  const versionIds = versions.map((v) => v.id);
  const versionFields =
    versionIds.length > 0
      ? yield* Result.await(
          safeDb((tx) =>
            tx.query.fields.findMany({
              where: { entityVersionId: { in: versionIds } },
              columns: {
                id: true,
                entityVersionId: true,
                propertyId: true,
                content: true,
              },
            }),
          ),
        )
      : [];

  // Build version → file field map (pick the first file-type field)
  const versionFileMap = new Map<
    string,
    {
      fieldId: string;
      propertyId: string;
      fileName: string;
      mimeType: string;
      sizeBytes: number;
    }
  >();

  for (const f of versionFields) {
    if (f.content.type === "file" && !versionFileMap.has(f.entityVersionId)) {
      const c = f.content as FieldContent & { type: "file" };
      versionFileMap.set(f.entityVersionId, {
        fieldId: f.id,
        propertyId: f.propertyId,
        fileName: c.fileName,
        mimeType: c.mimeType,
        sizeBytes: c.sizeBytes,
      });
    }
  }

  // Assemble response
  const versionsList = versions.map((v) => {
    const sessionAuthorId = sessionAuthorMap.get(v.id);
    const authorId = v.createdBy ?? sessionAuthorId ?? entity.createdBy;
    const authorUser = authorId ? userMap.get(authorId) : null;
    const file = versionFileMap.get(v.id) ?? null;

    return {
      id: v.id,
      versionNumber: v.versionNumber,
      stamp: v.stamp,
      label: v.label,
      description: v.description,
      diffWordsAdded: v.diffWordsAdded,
      diffWordsRemoved: v.diffWordsRemoved,
      createdAt: v.createdAt.toISOString(),
      author: authorUser
        ? { id: authorUser.id, name: authorUser.name, image: authorUser.image }
        : null,
      file,
    };
  });

  return Result.ok({
    entityId: entity.id,
    entityName: entity.name,
    kind: entity.kind,
    currentVersionId: entity.currentVersionId,
    versions: versionsList,
  });
};

const config = {
  permissions: { workspace: ["read"] },
  params: readVersionsParamsSchema,
} satisfies HandlerConfig;

const readVersions = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, params }) {
    return yield* readVersionsHandler({
      safeDb,
      workspaceId,
      entityId: params.entityId,
    });
  },
);

export default readVersions;
