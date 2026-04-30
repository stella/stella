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
                // The row UI needs the file field for documents (mime
                // icon + click-to-open) but Drizzle's relational
                // `orderBy` here can't take a SQL "prefer file" rule,
                // so we fetch all fields and pick the file-first in
                // JS. Acceptable while LIMITS.overviewRecentEntities
                // and per-matter property counts stay small; revisit
                // with a `DISTINCT ON ... ORDER BY (content->>'type'
                // = 'file') DESC` raw query if either grows.
                fields: {
                  columns: { id: true, propertyId: true, content: true },
                },
              },
            },
            createdByUser: {
              columns: { name: true, email: true, image: true },
            },
            lastEditedByUser: {
              columns: { name: true, email: true, image: true },
            },
            assignees: {
              columns: {},
              orderBy: { createdAt: "asc" },
              limit: 1,
              with: {
                user: {
                  columns: { name: true, email: true, image: true },
                },
              },
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
    // Prefer the file field so document rows render the right mime
    // icon and click-to-open works.
    const primaryField =
      cv.fields.find((f) => f.content.type === "file") ?? cv.fields.at(0);
    let name = e.name ?? "Untitled";
    let mimeType: string | null = null;
    let fieldId: string | null = null;
    let propertyId: string | null = null;
    let pdfFileId: string | null = null;
    let encrypted = false;
    if (primaryField) {
      fieldId = primaryField.id;
      propertyId = primaryField.propertyId;
      const c = primaryField.content;
      if (c.type === "text") {
        name = c.value;
      } else if (c.type === "file") {
        name = c.fileName;
        mimeType = c.mimeType;
        pdfFileId = c.pdfFileId;
        encrypted = c.encrypted;
      }
    }

    // Prefer last editor over original creator for the activity feed
    const editor = e.lastEditedByUser ?? e.createdByUser;
    const displayName = editor ? editor.name || editor.email : null;
    const primaryAssignee = e.assignees.at(0)?.user;
    const assigneeName = primaryAssignee
      ? primaryAssignee.name || primaryAssignee.email
      : null;

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
      assignedTo: assigneeName,
      assignedToImage: primaryAssignee?.image ?? null,
    };
  });

  return {
    entityCount,
    documentCount,
    taskCount,
    recentEntities: recent,
  };
};
