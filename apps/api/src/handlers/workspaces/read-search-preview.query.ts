import { panic } from "better-result";
import {
  and,
  asc,
  desc,
  eq,
  isNotNull,
  isNull,
  notInArray,
  or,
} from "drizzle-orm";

import { TASK_STATUS } from "@stll/api-contract";

import type { ScopedDb } from "@/api/db/safe-db";
import { entities } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

type ReadSearchPreviewOptions = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
};

export const readSearchPreviewHandler = async ({
  scopedDb,
  workspaceId,
}: ReadSearchPreviewOptions) =>
  await scopedDb(async (tx) => {
    const [upcomingAgenda, updatedDocuments, legacyDocuments] =
      await Promise.all([
        tx
          .select({
            id: entities.id,
            name: entities.name,
            dueDate: entities.dueDate,
          })
          .from(entities)
          .where(
            and(
              eq(entities.workspaceId, workspaceId),
              eq(entities.kind, "task"),
              isNotNull(entities.dueDate),
              or(
                isNull(entities.status),
                notInArray(entities.status, [
                  TASK_STATUS.DONE,
                  TASK_STATUS.CANCELLED,
                ]),
              ),
            ),
          )
          .orderBy(asc(entities.dueDate), asc(entities.id))
          .limit(LIMITS.matterSearchPreviewAgendaItems),
        tx
          .select({
            id: entities.id,
            name: entities.name,
            updatedAt: entities.updatedAt,
          })
          .from(entities)
          .where(
            and(
              eq(entities.workspaceId, workspaceId),
              eq(entities.kind, "document"),
              isNotNull(entities.updatedAt),
            ),
          )
          .orderBy(desc(entities.updatedAt), desc(entities.id))
          .limit(LIMITS.matterSearchPreviewDocuments),
        tx
          .select({
            id: entities.id,
            name: entities.name,
            updatedAt: entities.createdAt,
          })
          .from(entities)
          .where(
            and(
              eq(entities.workspaceId, workspaceId),
              eq(entities.kind, "document"),
              isNull(entities.updatedAt),
            ),
          )
          .orderBy(desc(entities.createdAt), desc(entities.id))
          .limit(LIMITS.matterSearchPreviewDocuments),
      ]);

    const recentDocuments = [...updatedDocuments, ...legacyDocuments]
      .map((document) => ({
        id: document.id,
        name: document.name,
        updatedAt:
          document.updatedAt ??
          panic("Matter preview document has no activity timestamp"),
      }))
      .sort((left, right) => {
        const dateOrder = right.updatedAt.getTime() - left.updatedAt.getTime();
        if (dateOrder !== 0 || left.id === right.id) {
          return dateOrder;
        }
        return left.id < right.id ? 1 : -1;
      })
      .slice(0, LIMITS.matterSearchPreviewDocuments);

    return {
      upcomingAgenda: upcomingAgenda.map((item) => ({
        id: item.id,
        name: item.name,
        dueDate:
          item.dueDate ?? panic("Dated matter preview item has no due date"),
      })),
      recentDocuments: recentDocuments.map((document) => ({
        id: document.id,
        name: document.name,
        updatedAt: document.updatedAt.toISOString(),
      })),
    };
  });
