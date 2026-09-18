import { t } from "elysia";

import { createSafeHandler } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";

import { createTimeEntryHandler } from "./time-entry-insert";

const createTimeEntryBodySchema = t.Object({
  workItemId: t.Optional(
    t.Nullable(
      tSafeId("entity", {
        description:
          "Optional document, folder, or task that provides context for the work",
      }),
    ),
  ),
  dateWorked: t.String({
    format: "date",
    description: "Date the work was done (ISO YYYY-MM-DD)",
  }),
  timezoneId: t.String({
    minLength: 1,
    maxLength: 64,
    description:
      "IANA time zone the dateWorked is interpreted in (e.g. Europe/Prague)",
  }),
  durationMinutes: t.Integer({
    minimum: 1,
    description: "Minutes worked (whole minutes)",
  }),
  narrative: t.String({
    minLength: 1,
    maxLength: 10_000,
    description: "Description of the work",
  }),
  billable: t.Optional(
    t.Boolean({ description: "Whether the entry is billable to the client" }),
  ),
  taskCode: t.Optional(
    t.Nullable(
      t.String({
        maxLength: 20,
        description: "UTBMS/LEDES task code; pass null to clear",
      }),
    ),
  ),
  activityCode: t.Optional(
    t.Nullable(
      t.String({
        maxLength: 20,
        description: "UTBMS/LEDES activity code; pass null to clear",
      }),
    ),
  ),
});

const createTimeEntry = createSafeHandler(
  {
    description:
      "Create a time entry in the current matter. dateWorked, timezoneId, " +
      "durationMinutes, and narrative are required; workItemId is optional. " +
      "The timekeeper's effective matter rate is resolved server-side. " +
      "durations are whole minutes. Returns the time entry ID.",
    permissions: { timeEntry: ["create"] },
    mcp: { type: "tool", name: "save_time_entry" },
    body: createTimeEntryBodySchema,
  },
  async function* ({
    safeDb,
    session,
    workspaceId,
    user,
    body,
    recordAuditEvent,
  }) {
    return yield* createTimeEntryHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      workspaceId,
      userId: user.id,
      recordAuditEvent,
      body,
    });
  },
);

export default createTimeEntry;
