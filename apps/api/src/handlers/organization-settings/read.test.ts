import { describe, expect, test } from "bun:test";

import readOrganizationSettings, {
  projectOrganizationSettingsRow,
} from "@/api/handlers/organization-settings/get";
import { resolveFeatureAccessSnapshot } from "@/api/lib/auth/feature-access/context";
import { createFeatureAccessSnapshot } from "@/api/lib/auth/feature-access/policy";
import { toSafeId } from "@/api/lib/branded-types";
import type { FeatureRegistry } from "@/api/lib/feature-access/registry";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const emptySnapshot = createFeatureAccessSnapshot({
  organizationId: "org_test",
  userId: "user_test",
  decisions: new Map(),
});

describe("projectOrganizationSettingsRow", () => {
  test("returns the active org's practiceJurisdictions verbatim", () => {
    const result = projectOrganizationSettingsRow(
      {
        documentProcessingMode: "searchable-text",
        matterNumberPadding: 3,
        matterNumberPattern: "{SEQ}",
        practiceJurisdictions: [
          { countryCode: "CZ", isPrimary: true },
          { countryCode: "SK", isPrimary: false },
        ],
        promptCachingEnabled: true,
        managedAIResidency: "us",
        memoryExtractionEnabled: false,
        timeMinimumUnitMinutes: 6,
        timeEditWindowDays: 90,
        timeLockedThroughMonth: null,
        timeNarrativeRequired: true,
        timeZone: null,
      },
      emptySnapshot,
    );

    expect(result.practiceJurisdictions).toEqual([
      { countryCode: "CZ", isPrimary: true },
      { countryCode: "SK", isPrimary: false },
    ]);
    expect(result.documentProcessingMode).toBe("searchable-text");
    expect(result.managedAIResidency).toBe("us");
  });

  test("defaults practiceJurisdictions to an empty array when no row exists", () => {
    expect(
      projectOrganizationSettingsRow(null, emptySnapshot).practiceJurisdictions,
    ).toEqual([]);
    expect(
      projectOrganizationSettingsRow(undefined, emptySnapshot)
        .practiceJurisdictions,
    ).toEqual([]);
  });

  test("defaults document processing to off when settings do not exist", () => {
    expect(
      projectOrganizationSettingsRow(null, emptySnapshot)
        .documentProcessingMode,
    ).toBe("off");
  });

  test("defaults time policy when settings do not exist", () => {
    expect(projectOrganizationSettingsRow(null, emptySnapshot)).toMatchObject({
      timeMinimumUnitMinutes: 6,
      timeEditWindowDays: 90,
      timeLockedThroughMonth: null,
      timeNarrativeRequired: true,
      managedAIResidency: "eu",
    });
  });
});

test("organization settings expose registry-derived enabled or hidden statuses without proof or grants", async () => {
  const registry = {
    "fixture-invitation": { enrolment: "invitation" },
    "fixture-self-serve": { enrolment: "self-serve" },
  } as const satisfies FeatureRegistry;
  const organizationId = toSafeId<"organization">("org_test");
  for (const email of ["standard@example.test", "colleague@example.test"]) {
    const database = createScopedDbMock({
      query: { organizationSettings: { findFirst: async () => undefined } },
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: async () => [{ email, emailVerified: true }],
            }),
          }),
        }),
      }),
    });
    const snapshot = await database.scopedDb(
      async (tx) =>
        await resolveFeatureAccessSnapshot({
          tx,
          organizationId,
          userId: "user_test",
          registry,
          grants: {
            "fixture-invitation": [
              {
                type: "member",
                organizationId,
                email: "standard@example.test",
              },
            ],
          },
        }),
    );
    const result = await readOrganizationSettings.handler(
      createTestHandlerContext<
        Parameters<typeof readOrganizationSettings.handler>[0]
      >({
        safeDb: database.safeDb,
        scopedDb: database.scopedDb,
        featureAccessSnapshot: snapshot,
      }),
    );
    expect(result).toMatchObject({
      capabilities: {
        "fixture-invitation": {
          status: email === "standard@example.test" ? "enabled" : "hidden",
        },
        "fixture-self-serve": { status: "hidden" },
      },
    });
    const projected = projectOrganizationSettingsRow(null, snapshot);
    expect(Object.keys(projected.capabilities)).toEqual(Object.keys(registry));
    expect(JSON.stringify(projected.capabilities)).not.toContain("proof");
    expect(JSON.stringify(projected.capabilities)).not.toContain(
      "standard@example.test",
    );
  }
});

test("organization settings derive an empty capability object from the empty production registry", async () => {
  let identityQueries = 0;
  const database = createScopedDbMock({
    query: { organizationSettings: { findFirst: async () => undefined } },
    select: () => {
      identityQueries += 1;
    },
  });
  const result = await readOrganizationSettings.handler(
    createTestHandlerContext<
      Parameters<typeof readOrganizationSettings.handler>[0]
    >({
      safeDb: database.safeDb,
      scopedDb: database.scopedDb,
    }),
  );
  expect(result).toMatchObject({ capabilities: {} });
  expect(identityQueries).toBe(0);
  expect(database.getCallCount()).toBe(1);
});

test("organization settings recompute a supplied snapshot when the user or active organization changes", async () => {
  const registry = {
    "fixture-invitation": { enrolment: "invitation" },
  } as const satisfies FeatureRegistry;
  const database = createScopedDbMock({
    query: { organizationSettings: { findFirst: async () => undefined } },
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: async () => [
              { email: "standard@example.test", emailVerified: true },
            ],
          }),
        }),
      }),
    }),
  });
  const snapshot = await database.scopedDb(
    async (tx) =>
      await resolveFeatureAccessSnapshot({
        tx,
        organizationId: toSafeId<"organization">("org_test"),
        userId: "user_test",
        registry,
        grants: {
          "fixture-invitation": [
            { type: "organization", organizationId: "org_test" },
          ],
        },
      }),
  );
  expect(projectOrganizationSettingsRow(null, snapshot).capabilities).toEqual({
    "fixture-invitation": { status: "enabled" },
  });
  for (const principal of [
    { organizationId: "org_other", userId: "user_test" },
    { organizationId: "org_test", userId: "user_other" },
  ]) {
    const result = await readOrganizationSettings.handler(
      createTestHandlerContext<
        Parameters<typeof readOrganizationSettings.handler>[0]
      >({
        safeDb: database.safeDb,
        scopedDb: database.scopedDb,
        featureAccessSnapshot: snapshot,
        session: {
          activeOrganizationId: toSafeId<"organization">(
            principal.organizationId,
          ),
        },
        user: { id: toSafeId<"user">(principal.userId) },
      }),
    );
    expect(result).toMatchObject({ capabilities: {} });
  }
});
