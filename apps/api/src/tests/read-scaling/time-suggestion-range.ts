import { panic } from "better-result";
import { inArray } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { auditLogs, workspaces } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import listMySuggestionRange from "@/api/handlers/time-entries/me/suggestions/list";
import { HttpStatusResponse } from "@/api/http/status";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  recordAuditGroups,
} from "@/api/lib/audit-log";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import {
  queryCountLogger,
  runWithMeasuredQueryCounter,
} from "@/api/lib/db-query-counter";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { deleteMatterBillingRecords } from "@/api/tests/helpers/matter-billing-cleanup";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { withTimeBillingEnrolment } from "@/api/tests/helpers/time-billing-enrolment";
import {
  type TestDatabase,
  withQueryLogger,
} from "@/api/tests/security/test-utils";

/** Matters with activity inside the measured week: the fixed response size. */
const ACTIVE_MATTERS = 10;
const WEEK_START = "2019-04-01";
const WEEK_END = "2019-04-07";
/** Activity the response returns: one scope per active matter. */
const INSIDE_WEEK = new Date("2019-04-02T09:00:00Z");
/** Activity the response never returns: the week after the measured one. */
const OUTSIDE_WEEK = new Date("2019-04-09T09:00:00Z");

type SeedOptions = {
  organizationId: SafeId<"organization">;
  clientId: SafeId<"contact">;
  userId: SafeId<"user">;
  /** Matters the timekeeper can access; only ten have work in the week. */
  size: number;
};

/**
 * Seeds `size` accessible matters, each with one of the timekeeper's actions.
 * Ten fall inside the measured week, one scope per matter; the rest
 * fall outside it, so the population grows while the response stays fixed.
 */
export const seedSuggestionRangeScaling = async (
  database: TestDatabase,
  { organizationId, clientId, userId, size }: SeedOptions,
) => {
  const matters = Array.from({ length: size }, () =>
    createSafeId<"workspace">(),
  );
  await database.insert(workspaces).values(
    matters.map((id, index) => ({
      id,
      organizationId,
      clientId,
      name: `Scaling matter ${index}`,
      reference: `SCALE-${id}`,
    })),
  );
  // One recorder call for every matter keeps derived audit columns exactly as
  // production writes them; only the timestamps move onto the fixture's days.
  const resourceIds = matters.map(() => createSafeId<"entity">());
  await database.transaction(async (tx) => {
    await recordAuditGroups({
      tx: asTestRaw<Transaction>(tx),
      groups: matters.map((workspaceId, index) => ({
        bindings: {
          organizationId,
          workspaceId,
          userId,
          execution: {
            performer: { type: "user", id: userId },
            trigger: { type: "direct" },
          },
        },
        events: [
          {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
            resourceId: resourceIds[index] ?? panic("Missing scaling resource"),
          },
        ],
      })),
    });
  });
  await database
    .update(auditLogs)
    .set({ createdAt: INSIDE_WEEK })
    .where(inArray(auditLogs.resourceId, resourceIds.slice(0, ACTIVE_MATTERS)));
  await database
    .update(auditLogs)
    .set({ createdAt: OUTSIDE_WEEK })
    .where(inArray(auditLogs.resourceId, resourceIds.slice(ACTIVE_MATTERS)));
  return {
    database: withQueryLogger(database, queryCountLogger),
    organizationId,
    userId,
    matters,
    cleanup: async () => {
      await database
        .delete(auditLogs)
        .where(inArray(auditLogs.resourceId, resourceIds));
      await deleteMatterBillingRecords(database, { workspaceIds: matters });
      await database.delete(workspaces).where(inArray(workspaces.id, matters));
    },
  };
};

type SuggestionRangeFixture = Awaited<
  ReturnType<typeof seedSuggestionRangeScaling>
>;

export const suggestionRangeScalingScenario = {
  name: "personal suggestion range",
  definition: listMySuggestionRange,
  measure: async (fixture: SuggestionRangeFixture) =>
    await runWithMeasuredQueryCounter(async (counter) => {
      const response = await listMySuggestionRange.handler(
        withTimeBillingEnrolment(
          asTestRaw<Parameters<typeof listMySuggestionRange.handler>[0]>({
            query: {
              startDate: WEEK_START,
              endDate: WEEK_END,
              timezoneId: "UTC",
            },
            request: new Request(
              "https://example.test/v1/time-entries/me/suggestions",
            ),
            route: "/v1/time-entries/me/suggestions",
            safeDb: createSafeDb(
              fixture.database,
              fixture.matters,
              fixture.organizationId,
              fixture.userId,
            ),
            getActiveWorkspaceIds: async () =>
              await Promise.resolve(fixture.matters),
            session: { activeOrganizationId: fixture.organizationId },
            user: { id: fixture.userId },
            memberRole: sessionMemberRole("member"),
          }),
        ),
      );
      if (response instanceof HttpStatusResponse || !("days" in response)) {
        return panic("Suggestion range scaling requires a successful response");
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(response)),
        rows: response.days.reduce((sum, day) => sum + day.matters.length, 0),
      };
    }),
};
