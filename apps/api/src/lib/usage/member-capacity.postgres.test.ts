/**
 * The member insert guard under concurrent additions: two sessions each add
 * a member to an organization with one place left. The second insert waits
 * for the first transaction and is refused once it commits, so the capacity
 * holds without any application-side lock.
 */

import { describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { DAY_IN_MS } from "@stll/time";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  ORGANIZATION_ACCESS_STATE,
  organizationAccessStates,
  usageEntitlements,
  usagePolicies,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const BLOCK_OBSERVATION_ATTEMPTS = 200;

const errorChainText = (error: unknown): string => {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    parts.push(current.message);
    current = current.cause;
  }
  return parts.join(" <- ");
};

if (!databaseUrl || !runPostgresTests) {
  describe.skip("organization member capacity race (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("organization member capacity race (postgres)", () => {
    test("two concurrent additions to the last place admit exactly one", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const setup = openClient({ max: 1 });
        const first = openClient({ max: 1 });
        const second = openClient({ max: 1 });

        const organizationId = mintAuthProviderId<"organization">();
        const usagePolicyId = createSafeId<"usagePolicy">();
        const userIds = [
          mintAuthProviderIdValue(),
          mintAuthProviderIdValue(),
          mintAuthProviderIdValue(),
        ];
        const [existingUserId, firstUserId, secondUserId] = userIds;
        if (!existingUserId || !firstUserId || !secondUserId) {
          throw new Error("fixture user ids are missing");
        }
        const now = Date.now();

        try {
          await setup.db.insert(user).values(
            userIds.map((id) => ({
              id,
              name: "Capacity race",
              email: `${id}@capacity-race.test`,
            })),
          );
          await setup.db.insert(organization).values({
            id: organizationId,
            name: "Capacity race",
            slug: `capacity-race-${organizationId}`,
            createdAt: new Date(now),
          });
          await setup.db.insert(organizationAccessStates).values({
            organizationId,
            state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
            evaluationStartedAt: new Date(now - DAY_IN_MS),
            evaluationEndsAt: new Date(now + DAY_IN_MS),
          });
          await setup.db.insert(usagePolicies).values({
            id: usagePolicyId,
            policyKey: `capacity_race_${Bun.randomUUIDv7()}`,
            displayName: "Capacity race",
            monthlyUsageUnits: 7,
            priceBasis: "per_seat",
            maxMembers: 10,
          });
          await setup.db.insert(usageEntitlements).values({
            id: createSafeId<"usageEntitlement">(),
            organizationId,
            usagePolicyId,
            status: "active",
            seats: 2,
            currentPeriodStart: new Date(now - DAY_IN_MS),
            currentPeriodEnd: new Date(now + 30 * DAY_IN_MS),
            source: "manual",
          });
          await setup.db.insert(member).values({
            id: mintAuthProviderIdValue(),
            organizationId,
            userId: existingUserId,
            role: "owner",
            createdAt: new Date(now),
          });

          const [secondSession] = await second.sql<
            { pid: number }[]
          >`SELECT pg_backend_pid() AS pid`;
          if (!secondSession) {
            throw new Error("the second session has no backend pid");
          }

          const { promise: firstInserted, resolve: markFirstInserted } =
            Promise.withResolvers<undefined>();
          const { promise: releaseFirst, resolve: commitFirst } =
            Promise.withResolvers<undefined>();
          const firstAddition = first.sql.begin(async (tx) => {
            await tx`
              INSERT INTO member (id, organization_id, user_id, role, created_at)
              VALUES (${mintAuthProviderIdValue()}, ${organizationId}, ${firstUserId}, 'member', now())
            `;
            markFirstInserted(undefined);
            await releaseFirst;
          });
          await firstInserted;

          const secondAddition = second.sql
            .begin(async (tx) => {
              await tx`
                INSERT INTO member (id, organization_id, user_id, role, created_at)
                VALUES (${mintAuthProviderIdValue()}, ${organizationId}, ${secondUserId}, 'member', now())
              `;
            })
            .then(
              () => ({ refused: false as const, error: null }),
              (error: unknown) => ({ refused: true as const, error }),
            );

          let blocked = false;
          for (
            let attempt = 0;
            attempt < BLOCK_OBSERVATION_ATTEMPTS && !blocked;
            attempt += 1
          ) {
            const [row] = await setup.sql<{ blocked: boolean }[]>`
              SELECT cardinality(pg_blocking_pids(${secondSession.pid})) > 0 AS blocked
            `;
            blocked = row?.blocked === true;
            if (!blocked) {
              await Bun.sleep(10);
            }
          }
          expect(blocked).toBe(true);

          commitFirst(undefined);
          await firstAddition;
          const outcome = await secondAddition;

          expect(outcome.refused).toBe(true);
          expect(errorChainText(outcome.error)).toContain(
            "organization member capacity reached",
          );
          const members = await setup.db
            .select({ userId: member.userId })
            .from(member)
            .where(eq(member.organizationId, organizationId));
          expect(members.map((row) => row.userId).toSorted()).toEqual(
            [existingUserId, firstUserId].toSorted(),
          );
        } finally {
          await setup.db
            .delete(organization)
            .where(eq(organization.id, organizationId));
          await setup.db
            .delete(usagePolicies)
            .where(eq(usagePolicies.id, usagePolicyId));
          await setup.db.delete(user).where(inArray(user.id, userIds));
        }
      });
    });
  });
}
