import { panic } from "better-result";
import { eq, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db";
import { entities } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

type ReadOverviewHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
};

export const readOverviewHandler = async ({
  scopedDb,
  workspaceId,
}: ReadOverviewHandlerProps) => {
  const { entityCount, recentEntities, kindCounts } = await scopedDb(
    async (tx) => {
      const [count, recent, kinds] = await Promise.all([
        tx
          .select({ count: sql<number>`count(*)::int` })
          .from(entities)
          .where(eq(entities.workspaceId, workspaceId))
          .then((rows) => rows.at(0)?.count ?? 0),
        tx.query.entities.findMany({
          where: {
            workspaceId: { eq: workspaceId },
            kind: { ne: "folder" },
          },
          columns: {
            id: true,
            name: true,
            kind: true,
            status: true,
            priority: true,
            dueDate: true,
            createdBy: true,
            lastEditedBy: true,
            createdAt: true,
            updatedAt: true,
          },
          with: {
            currentVersion: {
              columns: { id: true },
              with: {
                fields: {
                  columns: { id: true, propertyId: true, content: true },
                  limit: 1,
                },
              },
            },
            createdByUser: {
              columns: { name: true, email: true, image: true },
            },
            lastEditedByUser: {
              columns: { name: true, email: true, image: true },
            },
          },
          orderBy: { updatedAt: "desc" },
          limit: LIMITS.overviewRecentEntities,
        }),
        tx
          .select({
            kind: entities.kind,
            count: sql<number>`count(*)::int`,
          })
          .from(entities)
          .where(eq(entities.workspaceId, workspaceId))
          .groupBy(entities.kind),
      ]);
      return {
        entityCount: count,
        recentEntities: recent,
        kindCounts: kinds,
      };
    },
  );

  let documentCount = 0;
  let taskCount = 0;
  for (const kc of kindCounts) {
    if (kc.kind === "document") {
      documentCount = kc.count;
    } else if (kc.kind === "task") {
      taskCount = kc.count;
    }
  }

  const recent = recentEntities.map((e) => {
    const cv = e.currentVersion ?? panic("Entity has no currentVersion");
    const firstField = cv.fields.at(0);
    let name = e.name ?? "Untitled";
    let mimeType: string | null = null;
    let fieldId: string | null = null;
    let propertyId: string | null = null;
    let pdfFileId: string | null = null;
    let encrypted = false;
    if (firstField) {
      fieldId = firstField.id;
      propertyId = firstField.propertyId;
      const c = firstField.content;
      if (c.type === "text" && "value" in c) {
        name = c.value;
      } else if (c.type === "file" && "fileName" in c) {
        name = c.fileName;
        mimeType = c.mimeType;
        pdfFileId = c.pdfFileId;
        encrypted = c.encrypted;
      }
    }

    // Prefer last editor over original creator for the activity feed
    const editor = e.lastEditedByUser ?? e.createdByUser;
    const displayName = editor ? editor.name || editor.email : null;

    return {
      entityId: e.id,
      name,
      kind: e.kind,
      status: e.status,
      priority: e.priority,
      dueDate: e.dueDate,
      mimeType,
      fieldId,
      propertyId,
      pdfFileId,
      encrypted,
      createdAt: e.createdAt.toISOString(),
      updatedAt: e.updatedAt?.toISOString() ?? null,
      createdBy: displayName,
      createdByImage: editor?.image ?? null,
    };
  });

  return {
    entityCount,
    documentCount,
    taskCount,
    recentEntities: recent,
  };
};
