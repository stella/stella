import { expect, test } from "bun:test";
import { getColumns } from "drizzle-orm";

import { entities, featureEnrolments } from "@/api/db/schema";
import { resolveFeatureAccessSnapshot } from "@/api/lib/auth/feature-access/context";
import { toSafeId } from "@/api/lib/branded-types";
import type { FeatureRegistry } from "@/api/lib/feature-access/registry";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const organizationId = toSafeId<"organization">("org-a");
const userId = "user-a";
const featureId = "time-billing";
const identity = { email: "member@example.test", emailVerified: true };

test("shared admission fixtures resolve every registry size with empty or explicit enrolments", async () => {
  for (const invitationCount of [0, 1, 3, 8]) {
    const invitationFeatures = Array.from(
      { length: invitationCount },
      (_, index) =>
        [
          `invitation-${String(index)}`,
          { enrolment: "invitation" as const },
        ] as const,
    );
    for (const entries of [
      invitationFeatures,
      invitationFeatures.toReversed(),
    ]) {
      const registry = {
        ...Object.fromEntries(entries),
        [featureId]: { enrolment: "self-serve" },
      } as const satisfies FeatureRegistry;
      for (const enrolled of [false, true]) {
        const database = createScopedDbMock(
          {},
          {
            featureAccess: {
              identity,
              ...(enrolled
                ? { enrolments: [{ featureId, organizationId, userId }] }
                : {}),
            },
          },
        );
        const snapshot = await database.scopedDb(
          async (tx) =>
            await resolveFeatureAccessSnapshot({
              tx,
              organizationId,
              userId,
              registry,
              grants: {},
            }),
        );
        expect(snapshot.decisions.size).toBe(invitationCount + 1);
        expect(snapshot.decisions.get(featureId)?.status).toBe(
          enrolled ? "enabled" : "hidden",
        );
        for (const [invitationId] of entries) {
          expect(snapshot.decisions.get(invitationId)?.status).toBe("hidden");
        }
        expect(database.getCallCount()).toBe(1);
      }
    }
  }
});

test("default enrolment reads never consume a resource fixture with matching projection keys", async () => {
  const resourceId = toSafeId<"entity">("resource");
  let resourceQueries = 0;
  const database = createScopedDbMock({
    select: () => {
      resourceQueries += 1;
      return {
        from: () => ({
          where: () => ({ limit: async () => [{ featureId: resourceId }] }),
        }),
      };
    },
  });
  for (const [name, column] of Object.entries(getColumns(featureEnrolments))) {
    const selection = { [name]: column };
    const rows = await database.scopedDb(
      async (tx) =>
        await tx
          .select(selection)
          .from(featureEnrolments)
          .where(undefined)
          .limit(1),
    );
    expect(rows).toEqual([]);
  }
  expect(resourceQueries).toBe(0);
  const resourceRows = await database.scopedDb(
    async (tx) =>
      await tx
        .select({ featureId: entities.id })
        .from(entities)
        .where(undefined)
        .limit(1),
  );
  expect(resourceRows).toEqual([{ featureId: resourceId }]);
  expect(resourceQueries).toBe(1);
});
