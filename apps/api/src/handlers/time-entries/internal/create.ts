import { Result } from "better-result";
import { t } from "elysia";

import {
  TIME_ENTRY_ACTIVITY_GROUP,
  TIME_ENTRY_SOURCE,
} from "@stll/api-contract";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { lockTimePolicy } from "@/api/lib/billing-time";
import { narrativeLanguageSchema } from "@/api/lib/billing/narrative-language";
import { canApproveTimeEntries } from "@/api/lib/billing/time-entry-authorization";
import {
  insertPreparedInternalTimeEntry,
  lockInternalTimeEntryCapacity,
  prepareInternalTimeEntryInsert,
} from "@/api/lib/billing/time-entry-insert";

const createInternalTimeEntry = createSafeRootHandler(
  {
    description:
      "Record internal work for yourself in the active organization without a matter. Requires work date (YYYY-MM-DD), IANA timezoneId, positive whole durationMinutes, and narrative. Internal work has no billable value; monthly locks, edit windows, and narrative policy still apply. Returns the entry id and activityGroup. Internal entries await administrator approval when no approver is assigned.",
    permissions: { timeEntry: ["create"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: { featureId: "time-billing", type: "required" },
    access: "write",
    mcp: {
      type: "capability",
      reason: "billing_admin",
      consumesServices: false,
    },
    body: t.Object(
      {
        dateWorked: t.String({ format: "date" }),
        timezoneId: t.String({ minLength: 1, maxLength: 64 }),
        durationMinutes: t.Integer({ minimum: 1 }),
        narrative: t.String({ maxLength: 10_000 }),
        narrativeLanguage: t.Optional(narrativeLanguageSchema),
      },
      { additionalProperties: false },
    ),
  },
  async function* ({
    safeDb,
    session,
    user,
    memberRole,
    body,
    recordAuditEvent,
  }) {
    const organizationId = session.activeOrganizationId;
    const outcome = yield* Result.await(
      safeDb(
        async (tx) =>
          await Result.gen(async function* () {
            const policy = await lockTimePolicy(tx, organizationId);
            const prepared = yield* prepareInternalTimeEntryInsert({
              policy,
              canApprove: canApproveTimeEntries(memberRole),
              body,
            });
            yield* Result.await(
              lockInternalTimeEntryCapacity({
                tx,
                organizationId,
                userId: user.id,
              }),
            );
            const entry = await insertPreparedInternalTimeEntry({
              tx,
              organizationId,
              userId: user.id,
              prepared,
              recordAuditEvent,
              source: TIME_ENTRY_SOURCE.MANUAL,
            });
            return Result.ok({
              id: entry.id,
              activityGroup: TIME_ENTRY_ACTIVITY_GROUP.INTERNAL,
            } as const);
          }),
      ),
    );
    return outcome;
  },
);
export default createInternalTimeEntry;
