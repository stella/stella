import { Result } from "better-result";
import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import { t } from "elysia";

import type { SafeDb } from "@/api/db";
import { desktopEditSessions, entityVersions } from "@/api/db/schema";
import {
  decodeVersionCursor,
  encodeVersionCursor,
} from "@/api/handlers/entities/version-cursor";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const readVersionsParamsSchema = workspaceParams({
  entityId: tSafeId("entity"),
});

const readVersionsQuerySchema = t.Object({
  before: t.Optional(t.String()),
});

type ReadVersionsHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  entityId: SafeId<"entity">;
  before: string | undefined;
};

const readVersionsHandler = async function* ({
  safeDb,
  workspaceId,
  entityId,
  before,
}: ReadVersionsHandlerProps) {
  const cursor = before !== undefined ? decodeVersionCursor(before) : null;
  if (before !== undefined && cursor === null) {
    return Result.err(
      new HandlerError({ status: 400, message: "Invalid cursor" }),
    );
  }

  const pageSize = LIMITS.versionsPageSizeDefault;

  const keyset = cursor
    ? or(
        lt(entityVersions.versionNumber, cursor.versionNumber),
        and(
          eq(entityVersions.versionNumber, cursor.versionNumber),
          lt(entityVersions.id, cursor.id),
        ),
      )
    : undefined;

  // One shared scoped transaction for the whole read-only sequence, in the
  // same dependency order as before: entity (also the entity-level author
  // fallback), the version page, finalized edit sessions for that page
  // (version → author for v2+), the author users those two sources collect
  // (skipped when neither produced an id), and the page's file fields. All
  // reads are scoped by workspaceId/entityId directly, so one transaction is
  // semantically identical to the independent transactions this replaced,
  // while paying for a single `set_config`. The missing-entity 404 is
  // threaded out via `kind` instead of returning early from inside the tx.
  const reads = yield* Result.await(
    safeDb(async (tx) => {
      const entity = await tx.query.entities.findFirst({
        where: {
          id: { eq: entityId },
          workspaceId: { eq: workspaceId },
        },
        columns: {
          id: true,
          name: true,
          kind: true,
          createdBy: true,
          currentVersionId: true,
        },
      });

      if (!entity) {
        return { kind: "not-found" as const };
      }

      const rows = await tx
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
            keyset,
          ),
        )
        .orderBy(desc(entityVersions.versionNumber), desc(entityVersions.id))
        .limit(pageSize + 1);

      const hasOlder = rows.length > pageSize;
      const versions = rows.slice(0, pageSize);

      if (versions.length === 0) {
        return {
          kind: "ok" as const,
          entity,
          versions,
          hasOlder,
          sessionAuthorMap: new Map<string, string>(),
          userMap: new Map<
            string,
            { id: string; name: string; image: string | null }
          >(),
          versionFields: [],
        };
      }

      const pageVersionIds = versions.map((v) => v.id);

      // Get finalized sessions for this page to map version → author (for v2+).
      const sessions = await tx
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
            inArray(desktopEditSessions.finalizedVersionId, pageVersionIds),
          ),
        );

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
          ? // SAFETY: distinct version authors of one entity page, an IN-list of user IDs bounded by LIMITS.workspaceMembersCount
            // eslint-disable-next-line require-query-limit/require-query-limit
            await tx.query.user.findMany({
              where: { id: { in: [...authorUserIds] } },
              columns: { id: true, name: true, image: true },
            })
          : [];

      const userMap = new Map(authorUsers.map((u) => [u.id, u]));

      // Fetch file fields for this page's versions
      const versionFields = await tx.query.fields.findMany({
        where: { entityVersionId: { in: pageVersionIds } },
        limit: LIMITS.versionFieldsScanLimit,
        columns: {
          id: true,
          entityVersionId: true,
          propertyId: true,
          content: true,
        },
      });

      return {
        kind: "ok" as const,
        entity,
        versions,
        hasOlder,
        sessionAuthorMap,
        userMap,
        versionFields,
      };
    }),
  );

  if (reads.kind === "not-found") {
    return Result.err(
      new HandlerError({ status: 404, message: "Entity not found" }),
    );
  }

  const {
    entity,
    versions,
    hasOlder,
    sessionAuthorMap,
    userMap,
    versionFields,
  } = reads;

  const oldest = versions.at(-1);
  const olderCursor =
    hasOlder && oldest
      ? encodeVersionCursor({
          versionNumber: oldest.versionNumber,
          id: oldest.id,
        })
      : null;

  if (versions.length === 0) {
    return Result.ok({
      entityId: entity.id,
      entityName: entity.name,
      kind: entity.kind,
      currentVersionId: entity.currentVersionId,
      versions: [],
      olderCursor,
    });
  }

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
      versionFileMap.set(f.entityVersionId, {
        fieldId: f.id,
        propertyId: f.propertyId,
        fileName: f.content.fileName,
        mimeType: f.content.mimeType,
        sizeBytes: f.content.sizeBytes,
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
    olderCursor,
  });
};

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "covered", by: "read_document" },
  params: readVersionsParamsSchema,
  query: readVersionsQuerySchema,
} satisfies HandlerConfig;

const readVersions = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, params, query }) {
    return yield* readVersionsHandler({
      safeDb,
      workspaceId,
      entityId: params.entityId,
      before: query.before,
    });
  },
);

export default readVersions;
