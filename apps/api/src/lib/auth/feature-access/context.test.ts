import { expect, test } from "bun:test";

import {
  loadFeatureAccessSnapshot,
  resolveFeatureAccess,
  resolveFeatureAccessSnapshot,
} from "@/api/lib/auth/feature-access/context";
import { toSafeId } from "@/api/lib/branded-types";
import type { FeatureRegistry } from "@/api/lib/feature-access/registry";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const registry = {
  "fixture-one": { enrolment: "invitation" },
  "fixture-two": { enrolment: "invitation" },
  "fixture-self-serve": { enrolment: "self-serve" },
} as const satisfies FeatureRegistry;
const organizationId = toSafeId<"organization">("org-a");
const grants = {
  "fixture-one": [
    { type: "member", organizationId: "org-a", email: "member@example.test" },
  ],
  "fixture-two": [{ type: "organization", organizationId: "org-a" }],
} as const;

test("the production feature snapshot resolves current identity once", async () => {
  const database = createScopedDbMock(
    {},
    {
      featureAccess: {
        identity: { email: "member@example.test", emailVerified: true },
      },
    },
  );
  const result = await loadFeatureAccessSnapshot({
    safeDb: database.safeDb,
    organizationId,
    userId: "user-a",
  });
  expect(result.isOk()).toBe(true);
  if (result.isOk()) {
    expect(result.value.organizationId).toBe(organizationId);
    expect(result.value.userId).toBe("user-a");
    expect(result.value.decisions.get("list-verification")).toEqual({
      status: "hidden",
    });
  }
  expect(database.getCallCount()).toBe(1);
});

test("feature snapshots batch current identity across every registered feature", async () => {
  let identityReads = 0;
  const database = createScopedDbMock(
    {},
    {
      featureAccess: {
        get identity() {
          identityReads += 1;
          return { email: "member@example.test", emailVerified: true };
        },
      },
    },
  );
  const snapshot = await database.scopedDb(
    async (tx) =>
      await resolveFeatureAccessSnapshot({
        tx,
        organizationId,
        userId: "user-a",
        registry,
        grants,
      }),
  );
  expect(identityReads).toBe(1);
  expect([...snapshot.decisions.keys()]).toEqual(Object.keys(registry));
  expect(snapshot.decisions.get("fixture-one")?.status).toBe("enabled");
  expect(snapshot.decisions.get("fixture-two")?.status).toBe("enabled");
  expect(snapshot.decisions.get("fixture-self-serve")?.status).toBe("hidden");
});

test("missing requesters and an empty registry do not query identity or grant access", async () => {
  let identityReads = 0;
  const database = createScopedDbMock(
    {},
    {
      featureAccess: {
        get identity() {
          identityReads += 1;
          return null;
        },
      },
    },
  );
  const missing = await database.scopedDb(
    async (tx) =>
      await resolveFeatureAccessSnapshot({
        tx,
        organizationId,
        userId: null,
        registry,
        grants,
      }),
  );
  expect(
    [...missing.decisions.values()].every(({ status }) => status === "hidden"),
  ).toBe(true);
  const empty = await database.scopedDb(
    async (tx) =>
      await resolveFeatureAccessSnapshot({
        tx,
        organizationId,
        userId: "user-a",
        registry: {},
        grants: {},
      }),
  );
  expect(empty.decisions.size).toBe(0);
  expect(identityReads).toBe(0);
});

test("departed membership and unknown runtime feature ids resolve hidden", async () => {
  const database = createScopedDbMock(
    {},
    { featureAccess: { identity: null } },
  );
  for (const featureId of ["fixture-one", "unknown-feature"]) {
    const decision = await database.scopedDb(
      async (tx) =>
        await resolveFeatureAccess({
          tx,
          organizationId,
          userId: "user-a",
          featureId,
          registry,
          grants,
        }),
    );
    expect(decision).toEqual({ status: "hidden" });
  }
});
