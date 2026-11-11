import { panic } from "better-result";
import { inArray } from "drizzle-orm";

import { conflictChecks } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import getConflictCheck from "@/api/handlers/conflict-checks/get";
import listConflictChecks from "@/api/handlers/conflict-checks/list";
import { HttpStatusResponse } from "@/api/http/status";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import {
  queryCountLogger,
  runWithMeasuredQueryCounter,
} from "@/api/lib/db-query-counter";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { grantedConflictCheckSnapshot } from "@/api/tests/helpers/conflict-check-access";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  type TestDatabase,
  withQueryLogger,
} from "@/api/tests/security/test-utils";

/** The member's own checks: the list page, the same at every size. */
export const CONFLICT_CHECKS_PAGE = 5;

type SeedOptions = {
  organizationId: SafeId<"organization">;
  otherUserId: SafeId<"user">;
  userId: SafeId<"user">;
  /** A colleague's checks, which neither read may walk. */
  size: number;
};

const check = (
  organizationId: SafeId<"organization">,
  runBy: SafeId<"user">,
  index: number,
) => ({
  id: createSafeId<"conflictCheck">(),
  organizationId,
  runBy,
  title: `Intake ${String(index).padStart(4, "0")}`,
  parties: [
    {
      type: "organization" as const,
      role: "client" as const,
      name: `Prospect ${String(index)} s.r.o.`,
    },
  ],
  results: {
    version: 1 as const,
    contactsScreened: 0,
    gaps: [],
    parties: [
      { hits: [], totalMatches: 0, truncated: false, incomplete: false },
    ],
  },
  outcome: "no_matches" as const,
});

/**
 * Seeds the member's five checks beside `size` checks a colleague ran, which
 * row security hides from the member, so the hidden population grows while
 * the member's reads stay the same.
 */
export const seedConflictChecksScaling = async (
  database: TestDatabase,
  { organizationId, otherUserId, userId, size }: SeedOptions,
) => {
  const own = Array.from({ length: CONFLICT_CHECKS_PAGE }, (_, index) =>
    check(organizationId, userId, index),
  );
  const rows = [
    ...own,
    ...Array.from({ length: size }, (_, index) =>
      check(organizationId, otherUserId, index),
    ),
  ];
  await database.insert(conflictChecks).values(rows);
  const checkIds = rows.map(({ id }) => id);
  return {
    checkId: own.at(0)?.id ?? panic("The scaling seed holds no own check"),
    cleanup: async () => {
      await database
        .delete(conflictChecks)
        .where(inArray(conflictChecks.id, checkIds));
    },
    database: withQueryLogger(database, queryCountLogger),
    organizationId,
    userId,
  };
};

type ConflictChecksFixture = Awaited<
  ReturnType<typeof seedConflictChecksScaling>
>;

const context = (fixture: ConflictChecksFixture, route: string) => ({
  request: new Request(`https://example.test${route}`),
  route,
  safeDb: createSafeDb(
    fixture.database,
    [],
    fixture.organizationId,
    fixture.userId,
  ),
  session: { activeOrganizationId: fixture.organizationId },
  user: { id: fixture.userId },
  memberRole: sessionMemberRole("member"),
  featureAccessSnapshot: grantedConflictCheckSnapshot({
    organizationId: fixture.organizationId,
    userId: fixture.userId,
  }),
});

export const conflictCheckListScalingScenario = {
  name: "conflict check list",
  definition: listConflictChecks,
  measure: async (fixture: ConflictChecksFixture) =>
    await runWithMeasuredQueryCounter(async (counter) => {
      const response = await listConflictChecks.handler(
        asTestRaw<Parameters<typeof listConflictChecks.handler>[0]>({
          ...context(fixture, "/v1/conflict-checks"),
          query: {},
        }),
      );
      if (response instanceof HttpStatusResponse || !("items" in response)) {
        return panic("Conflict check list scaling requires a page");
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(response)),
        rows: response.items.length,
      };
    }),
};

export const conflictCheckReadScalingScenario = {
  name: "conflict check read",
  definition: getConflictCheck,
  measure: async (fixture: ConflictChecksFixture) =>
    await runWithMeasuredQueryCounter(async (counter) => {
      const response = await getConflictCheck.handler(
        asTestRaw<Parameters<typeof getConflictCheck.handler>[0]>({
          ...context(fixture, `/v1/conflict-checks/${fixture.checkId}`),
          params: { checkId: fixture.checkId },
        }),
      );
      if (response instanceof HttpStatusResponse || !("parties" in response)) {
        return panic("Conflict check read scaling requires a check");
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(response)),
        rows: response.parties.length,
      };
    }),
};
