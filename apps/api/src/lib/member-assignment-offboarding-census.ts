import type { PgColumn } from "drizzle-orm/pg-core";

import { agentDelegation, agentRegistration } from "@/api/db/agent-auth-schema";
import {
  apikey,
  invitation,
  member,
  oauthAccessToken,
  oauthConsent,
  oauthRefreshToken,
  session,
} from "@/api/db/auth-schema";
import {
  correspondence,
  desktopEditHandoffs,
  desktopEditSessions,
  desktopPresence,
  folioCollabRoomTokens,
  flowRuns,
  mcpOAuthState,
  mcpUserConnections,
  pdfSigningSessions,
  contacts,
  sharepointConnections,
  sharepointOAuthState,
  taskAssignees,
  timeEntries,
  workspaceMembers,
  workObligations,
  workspaces,
} from "@/api/db/schema";

/** How removal treats a column that names the departing member. */
export type MemberCleanupDisposition =
  /** The row is deleted, cancelled or expired, or the column is nulled. */
  | "cleared"
  /** Open work moves to `reassign_to` when given, otherwise it is cleared. */
  | "reassigned";

/**
 * Every column organization removal changes for the departing member, in the cleanup
 * owner or in the credential revocation it runs in the same transaction. The
 * schema coverage guard derives its census from this list.
 */
export const ORGANIZATION_MEMBER_CLEANUP_COLUMNS = [
  [member.userId, "cleared"],
  [desktopPresence.userId, "cleared"],
  [workspaceMembers.userId, "cleared"],
  [taskAssignees.userId, "reassigned"],
  [workObligations.ownerUserId, "reassigned"],
  [timeEntries.approverUserId, "cleared"],
  [contacts.originatingAttorneyId, "cleared"],
  [contacts.responsibleAttorneyId, "cleared"],
  [workspaces.leadUserId, "cleared"],
  [flowRuns.triggerSource, "cleared"],
  [desktopEditSessions.createdBy, "cleared"],
  [desktopEditSessions.takeoverRequestedBy, "cleared"],
  [desktopEditHandoffs.createdBy, "cleared"],
  [pdfSigningSessions.createdBy, "cleared"],
  [mcpUserConnections.userId, "cleared"],
  [mcpOAuthState.userId, "cleared"],
  [sharepointConnections.userId, "cleared"],
  [sharepointOAuthState.userId, "cleared"],
  [invitation.inviterId, "cleared"],
  [correspondence.assigneeId, "cleared"],
  // Revoked by `removeOrganizationMemberWithAuthArtifacts`.
  [session.userId, "cleared"],
  [apikey.referenceId, "cleared"],
  [oauthAccessToken.userId, "cleared"],
  [oauthRefreshToken.userId, "cleared"],
  [oauthConsent.userId, "cleared"],
  [agentRegistration.boundUserId, "cleared"],
  [agentDelegation.userId, "cleared"],
  [folioCollabRoomTokens.userId, "cleared"],
] as const satisfies readonly (readonly [PgColumn, MemberCleanupDisposition])[];

/**
 * Every column matter removal (`handlers/workspaces/members/remove.ts` with
 * `clearMemberAssignments`) changes for the departing member. The schema coverage guard derives from this list.
 */
export const WORKSPACE_MEMBER_CLEANUP_COLUMNS = [
  [workspaceMembers.userId, "cleared"],
  [taskAssignees.userId, "reassigned"],
  [workObligations.ownerUserId, "reassigned"],
  [timeEntries.approverUserId, "cleared"],
  [workspaces.leadUserId, "cleared"],
  [correspondence.assigneeId, "cleared"],
  [desktopEditSessions.createdBy, "cleared"],
  [desktopEditSessions.takeoverRequestedBy, "cleared"],
  [desktopEditHandoffs.createdBy, "cleared"],
  [pdfSigningSessions.createdBy, "cleared"],
] as const satisfies readonly (readonly [PgColumn, MemberCleanupDisposition])[];
