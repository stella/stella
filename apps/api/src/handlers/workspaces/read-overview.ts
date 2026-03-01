import { panic } from "better-result";
import { eq, sql } from "drizzle-orm";

import { db } from "@/api/db";
import { entities } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

type ReadOverviewHandlerProps = {
  workspaceId: SafeId<"workspace">;
};

export const readOverviewHandler = async ({
  workspaceId,
}: ReadOverviewHandlerProps) => {
  const [entityCount, recentEntities, kindCounts] = await Promise.all([
    db.$count(entities, eq(entities.workspaceId, workspaceId)),
    db.query.entities.findMany({
      where: { workspaceId },
      columns: {
        id: true,
        name: true,
        kind: true,
        createdBy: true,
        updatedAt: true,
      },
      with: {
        currentVersion: {
          columns: { id: true },
          with: {
            fields: {
              columns: { id: true, content: true },
              limit: 1,
            },
          },
        },
        createdByUser: {
          columns: { name: true, image: true },
        },
      },
      orderBy: { updatedAt: "desc" },
      limit: LIMITS.overviewRecentEntities,
    }),
    db
      .select({
        kind: entities.kind,
        count: sql<number>`count(*)::int`,
      })
      .from(entities)
      .where(eq(entities.workspaceId, workspaceId))
      .groupBy(entities.kind),
  ]);

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
    let pdfFileId: string | null = null;
    let encrypted = false;
    if (firstField) {
      fieldId = firstField.id;
      const c = firstField.content;
      if (c.type === "text" && "value" in c) {
        name = c.value;
      } else if (c.type === "file" && "fileName" in c) {
        name = c.fileName;
        mimeType = c.mimeType;
        pdfFileId = c.pdfFileId ?? null;
        encrypted = c.encrypted ?? false;
      }
    }

    return {
      entityId: e.id,
      name,
      kind: e.kind,
      mimeType,
      fieldId,
      pdfFileId,
      encrypted,
      updatedAt: e.updatedAt?.toISOString() ?? null,
      createdBy: e.createdByUser?.name ?? null,
      createdByImage: e.createdByUser?.image ?? null,
    };
  });

  return {
    entityCount,
    documentCount,
    taskCount,
    recentEntities: recent,
  };
};
