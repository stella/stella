import { Result } from "better-result";
import * as v from "valibot";

import { API_CALENDAR_DATE_CHECK } from "@stll/api-contract/api-date";
import { BILLING_CODE_MAX_LENGTH } from "@stll/api-contract/billing";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { resolveRate } from "@/api/lib/billing/rates";
import { userIdSchema, withDescription } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import { validateOrgUserId } from "@/api/lib/validated-org-user-id";

const resolveRateQuerySchema = v.object({
  activityCode: v.optional(
    v.pipe(v.string(), v.maxLength(BILLING_CODE_MAX_LENGTH)),
  ),
  userId: withDescription(userIdSchema, "User ID to resolve the rate for"),
  date: v.pipe(
    v.string(),
    v.isoDate(),
    API_CALENDAR_DATE_CHECK,
    v.description("Date to resolve the rate on (ISO YYYY-MM-DD)"),
  ),
});

const resolveRateHandler = createSafeHandler(
  {
    contract: "patch",
    description:
      "Resolve the effective hourly rate for a user on a given date in a " +
      "matter, using the default rate table: user plus activity, role plus activity, " +
      "activity, user, role, then table default. Effective dates apply throughout. Returns the hourly rate in integer " +
      "minor currency units (e.g. cents) and the currency, or nulls when no " +
      "rate applies.",
    permissions: { rate: ["read"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: { featureId: "time-billing", type: "required" },
    mcp: { type: "tool", name: "resolve_rate" },
    access: "read",
    query: resolveRateQuerySchema,
  },
  async function* ({ safeDb, workspaceId, session, query }) {
    const userId = query.userId;
    const validatedUserId = yield* Result.await(
      safeDb(
        async (tx) =>
          await validateOrgUserId(
            tx,
            brandPersistedUserId(userId),
            session.activeOrganizationId,
          ),
      ),
    );

    if (!validatedUserId) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "User is not a member of this organization",
        }),
      );
    }

    const result = yield* resolveRate({
      safeDb,
      workspaceId,
      userId: validatedUserId,
      dateWorked: query.date,
      activityCode: query.activityCode,
    });

    return Result.ok(result ?? { hourlyRate: null, currency: null });
  },
);

export default resolveRateHandler;
