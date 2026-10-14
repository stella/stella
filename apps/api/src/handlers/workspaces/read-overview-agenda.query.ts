import { panic } from "better-result";
import { and, isNull, or } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { entities } from "@/api/db/schema";
import {
  dueFromYesterday,
  openAgendaTask,
} from "@/api/handlers/workspaces/agenda-conditions";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

type ReadOverviewAgendaOptions = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
};

/**
 * The matter's upcoming agenda, read on its own rather than filtered from
 * recent activity, so an older open task is not pushed out by newer edits.
 * Nearest due date first; undated open tasks follow. Rows due yesterday by
 * the database's calendar are kept so the reader can apply its own today.
 */
export const readOverviewAgenda = async ({
  scopedDb,
  workspaceId,
}: ReadOverviewAgendaOptions) => {
  const rows = await scopedDb(
    async (tx) =>
      await tx.query.entities.findMany({
        where: {
          workspaceId: { eq: workspaceId },
          RAW: () =>
            and(
              openAgendaTask(),
              or(isNull(entities.dueDate), dueFromYesterday()),
            ) ?? panic("Agenda condition is never empty"),
        },
        columns: { id: true, name: true, status: true, dueDate: true },
        with: {
          assignees: {
            columns: {},
            orderBy: { createdAt: "asc" },
            limit: 1,
            with: {
              user: {
                columns: {
                  name: true,
                  email: true,
                  image: true,
                  deletedAt: true,
                },
              },
            },
          },
        },
        // Ascending due dates put undated tasks last.
        orderBy: { dueDate: "asc", id: "asc" },
        limit: LIMITS.overviewUpcomingAgenda,
      }),
  );
  return rows.map((task) => {
    const assignee = task.assignees.at(0)?.user;
    return {
      entityId: task.id,
      name: task.name,
      status: task.status,
      dueDate: task.dueDate,
      assignedTo: assignee ? assignee.name || assignee.email : null,
      assignedToImage: assignee?.image ?? null,
      assignedToDeletedAt: assignee?.deletedAt?.toISOString() ?? null,
    };
  });
};
