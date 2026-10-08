import { timeEntryRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { createTimeEntryBodySchema } from "@/api/lib/billing/time-entry-body";
import { createTimeEntryHandler } from "@/api/lib/billing/time-entry-insert";

const createTimeEntry = createSafeHandler(
  {
    description:
      "Create a time entry in the current matter. dateWorked, timezoneId, " +
      "durationMinutes, and narrative are required; workItemId is optional. " +
      "The timekeeper's effective matter rate is resolved server-side. " +
      "durations are whole minutes. Returns the time entry ID.",
    permissions: { timeEntry: ["create"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: { featureId: "time-billing", type: "required" },
    realtime: timeEntryRealtimeUpdates,
    mcp: { type: "tool", name: "save_time_entry" },
    body: createTimeEntryBodySchema,
  },
  async function* ({
    safeDb,
    session,
    workspaceId,
    memberRole,
    user,
    body,
    recordAuditEvent,
  }) {
    return yield* createTimeEntryHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      workspaceId,
      userId: user.id,
      memberRole,
      recordAuditEvent,
      body,
    });
  },
);

export default createTimeEntry;
