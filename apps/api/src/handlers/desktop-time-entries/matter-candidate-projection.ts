import { eq, sql } from "drizzle-orm";

import {
  contacts,
  entities,
  timeEntries,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import type { Transaction } from "@/api/db/types";
import type { SafeId } from "@/api/lib/branded-types";
import { TASK_STATUS } from "@/api/lib/entity-constants";
import { workTask } from "@/api/lib/tasks/work-task";

/**
 * The caller's own matching signals per matter. Correlated reads use the
 * existing matter-leading indexes and never read another user's document or
 * time-entry activity into a matching signal.
 */
export const matterCandidateSignals = (userId: SafeId<"user">) => ({
  lastWorkedAt: sql<string | null>`greatest(
      (select max(${timeEntries.dateWorked})::text from ${timeEntries} where ${timeEntries.workspaceId} = ${workspaces.id} and ${timeEntries.userId} = ${userId} and ${timeEntries.dateWorked} between current_date - 14 and current_date),
      (select max(${entities.updatedAt})::text from ${entities} where ${entities.workspaceId} = ${workspaces.id} and ${entities.kind} = 'document' and ${entities.lastEditedBy} = ${userId} and ${entities.updatedAt} >= now() - interval '14 days'),
      (select max(${entities.createdAt})::text from ${entities} where ${entities.workspaceId} = ${workspaces.id} and ${entities.kind} = 'document' and ${entities.createdBy} = ${userId} and ${entities.createdAt} >= now() - interval '14 days')
    )`,
  newlyAssignedAt: sql<
    string | null
  >`(select max(${workspaceMembers.createdAt})::text from ${workspaceMembers} where ${workspaceMembers.workspaceId} = ${workspaces.id} and ${workspaceMembers.userId} = ${userId} and ${workspaceMembers.createdAt} >= now() - interval '7 days')`,
  upcomingDeadline: sql<
    string | null
  >`(select min(${entities.dueDate})::text from ${entities} where ${entities.workspaceId} = ${workspaces.id} and ${workTask(entities)} and (${entities.status} is null or ${entities.status} not in (${TASK_STATUS.DONE}, ${TASK_STATUS.CANCELLED})) and ${entities.dueDate} between current_date and current_date + 7)`,
});
type MatterCandidateSignals = ReturnType<typeof matterCandidateSignals>;

/** The shortlist's order: the caller's most recent work first. */
export const matterCandidateRanking = ({
  lastWorkedAt,
  newlyAssignedAt,
  upcomingDeadline,
}: MatterCandidateSignals) =>
  [
    sql`${lastWorkedAt} desc nulls last`,
    sql`${newlyAssignedAt} desc nulls last`,
    sql`${upcomingDeadline} asc nulls last`,
    workspaces.id,
  ] as const;

/** One projection for every desktop read that names a matter to match, so
 * a resolved matter and a shortlisted one carry the same fields. Row access
 * is the caller's: the transaction's own scope decides which matters exist. */
export const selectMatterCandidates = (
  tx: Transaction,
  signals: MatterCandidateSignals,
) =>
  tx
    .select({
      id: workspaces.id,
      name: workspaces.name,
      reference: workspaces.reference,
      color: workspaces.color,
      clientName: contacts.displayName,
      ...signals,
    })
    .from(workspaces)
    .leftJoin(contacts, eq(contacts.id, workspaces.clientId));

export const toMatterCandidate = ({
  lastWorkedAt,
  newlyAssignedAt,
  upcomingDeadline,
  ...matter
}: Awaited<ReturnType<typeof selectMatterCandidates>>[number]) => ({
  ...matter,
  id: String(matter.id),
  reference: matter.reference || null,
  signals: { lastWorkedAt, newlyAssignedAt, upcomingDeadline },
});
