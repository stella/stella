import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import {
  DESKTOP_ACTIVITY_REVIEW_LIMIT,
  desktopMatterCandidatesResponseSchema,
} from "@stll/api-contract/desktop-time-entries";

import {
  contacts,
  entities,
  timeEntries,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";

import { authorizeDesktopTimeEntries } from "./authorize";

export const createDesktopMatterCandidatesEndpoint = (
  authorizeAccount: typeof authorizeDesktopAccount = authorizeDesktopAccount,
) =>
  createSafeBoundedPublicHandler(
    {
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "auth_plumbing" },
      cache: { kind: "none" },
      response: safePublicHandlerResponseSchemasWithStatusText(
        desktopMatterCandidatesResponseSchema,
      ),
    },
    async function* ({ request }) {
      const account = yield* Result.await(
        authorizeDesktopTimeEntries(request, authorizeAccount),
      );
      // Correlated reads use the existing matter-leading indexes and never read
      // another user's document or time-entry activity into a matching signal.
      const lastWorkedAtSignal = sql<string | null>`greatest(
      (select max(${timeEntries.dateWorked})::text from ${timeEntries} where ${timeEntries.workspaceId} = ${workspaces.id} and ${timeEntries.userId} = ${account.userId} and ${timeEntries.dateWorked} between current_date - 14 and current_date),
      (select max(${entities.updatedAt})::text from ${entities} where ${entities.workspaceId} = ${workspaces.id} and ${entities.kind} = 'document' and ${entities.lastEditedBy} = ${account.userId} and ${entities.updatedAt} >= now() - interval '14 days'),
      (select max(${entities.createdAt})::text from ${entities} where ${entities.workspaceId} = ${workspaces.id} and ${entities.kind} = 'document' and ${entities.createdBy} = ${account.userId} and ${entities.createdAt} >= now() - interval '14 days')
    )`;
      const newlyAssignedAtSignal = sql<
        string | null
      >`(select max(${workspaceMembers.createdAt})::text from ${workspaceMembers} where ${workspaceMembers.workspaceId} = ${workspaces.id} and ${workspaceMembers.userId} = ${account.userId} and ${workspaceMembers.createdAt} >= now() - interval '7 days')`;
      const upcomingDeadlineSignal = sql<
        string | null
      >`(select min(${entities.dueDate})::text from ${entities} where ${entities.workspaceId} = ${workspaces.id} and ${entities.dueDate} between current_date and current_date + 7)`;
      const rows = yield* Result.await(
        account.safeDb((tx) =>
          tx
            .select({
              id: workspaces.id,
              name: workspaces.name,
              reference: workspaces.reference,
              color: workspaces.color,
              clientName: contacts.displayName,
              lastWorkedAt: lastWorkedAtSignal,
              newlyAssignedAt: newlyAssignedAtSignal,
              upcomingDeadline: upcomingDeadlineSignal,
            })
            .from(workspaces)
            .leftJoin(contacts, eq(contacts.id, workspaces.clientId))
            .where(
              and(
                eq(workspaces.organizationId, account.organizationId),
                eq(workspaces.status, "active"),
              ),
            )
            .orderBy(
              sql`${lastWorkedAtSignal} desc nulls last`,
              sql`${newlyAssignedAtSignal} desc nulls last`,
              sql`${upcomingDeadlineSignal} asc nulls last`,
              workspaces.id,
            )
            .limit(DESKTOP_ACTIVITY_REVIEW_LIMIT),
        ),
      );
      return Result.ok({
        matters: rows.map(
          ({ lastWorkedAt, newlyAssignedAt, upcomingDeadline, ...matter }) => ({
            ...matter,
            signals: { lastWorkedAt, newlyAssignedAt, upcomingDeadline },
          }),
        ),
      });
    },
  );
export default createDesktopMatterCandidatesEndpoint();
