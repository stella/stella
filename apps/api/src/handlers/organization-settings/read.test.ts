import { describe, expect, test } from "bun:test";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import { env } from "@/api/env";
import readOrganizationSettings, {
  projectOrganizationSettingsRow,
} from "@/api/handlers/organization-settings/get";
import { resolveFeatureAccessSnapshot } from "@/api/lib/auth/feature-access/context";
import { toSafeId } from "@/api/lib/branded-types";
import { createFeatureAccessSnapshot } from "@/api/lib/feature-access/policy";
import {
  FEATURE_REGISTRY,
  LIST_VERIFICATION_FEATURE_ID,
  LEGAL_LISTS_FEATURE_ID,
} from "@/api/lib/feature-access/registry";
import type { FeatureRegistry } from "@/api/lib/feature-access/registry";
import { isMcpDescriptorFeatureEnabled } from "@/api/mcp/feature-access";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const emptySnapshot = createFeatureAccessSnapshot({
  organizationId: "org_test",
  userId: "user_test",
  decisions: new Map(),
});

// Identity resolves through the member join; the enrolment read finds no rows.
const unenrolledSettingsDatabase = (email: string) =>
  createScopedDbMock(
    { query: { organizationSettings: { findFirst: async () => undefined } } },
    { featureAccess: { identity: { email, emailVerified: true } } },
  );

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
    const database = unenrolledSettingsDatabase(email);
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
    expect(projected.declaredFeatureIds).toEqual(Object.keys(registry));
    for (const featureId of Object.keys(registry)) {
      for (const kind of ["capabilities", "tools", "resources"] as const) {
        expect(
          isMcpDescriptorFeatureEnabled({
            context: {
              organizationId,
              userId: toSafeId<"user">("user_test"),
              featureAccessSnapshot: snapshot,
            },
            kind,
            id: "fixture",
            featureId,
          }),
        ).toBe(projected.capabilities[featureId]?.status === "enabled");
      }
    }
    expect(Object.keys(projected.capabilities)).toEqual(Object.keys(registry));
    expect(JSON.stringify(projected.capabilities)).not.toContain("proof");
    expect(JSON.stringify(projected.capabilities)).not.toContain(
      "standard@example.test",
    );
  }
});

test("organization settings derive capabilities from the production registry, hidden without an enrolment", async () => {
  const database = unenrolledSettingsDatabase("standard@example.test");
  const result = await readOrganizationSettings.handler(
    createTestHandlerContext<
      Parameters<typeof readOrganizationSettings.handler>[0]
    >({
      safeDb: database.safeDb,
      scopedDb: database.scopedDb,
    }),
  );
  expect(result).toMatchObject({
    capabilities: Object.fromEntries(
      Object.keys(FEATURE_REGISTRY).map((featureId) => [
        featureId,
        { status: "hidden" },
      ]),
    ),
  });
});

test("organization settings recompute a supplied snapshot when the user or active organization changes", async () => {
  const registry = {
    "fixture-invitation": { enrolment: "invitation" },
  } as const satisfies FeatureRegistry;
  const database = unenrolledSettingsDatabase("standard@example.test");
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
    expect(result).toMatchObject({
      capabilities: Object.fromEntries(
        Object.keys(FEATURE_REGISTRY).map((featureId) => [
          featureId,
          { status: "hidden" },
        ]),
      ),
    });
    expect(result).not.toHaveProperty("capabilities.fixture-invitation");
  }
});

test("organization settings project the production verification declaration for granted and ungranted current members", async () => {
  const organizationId = toSafeId<"organization">("org_test");
  for (const granted of [false, true]) {
    const database = createScopedDbMock(
      { query: { organizationSettings: { findFirst: async () => undefined } } },
      {
        featureAccess: {
          identity: { email: "member@example.test", emailVerified: true },
        },
      },
    );
    const snapshot = await database.scopedDb(
      async (tx) =>
        await resolveFeatureAccessSnapshot({
          tx,
          organizationId,
          userId: "user_test",
          grants: granted
            ? {
                [LEGAL_LISTS_FEATURE_ID]: [
                  { type: "organization", organizationId },
                ],
                [LIST_VERIFICATION_FEATURE_ID]: [
                  { type: "organization", organizationId },
                ],
              }
            : {},
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
        [LIST_VERIFICATION_FEATURE_ID]: {
          status: granted ? "enabled" : "hidden",
        },
      },
    });
    const capabilities = projectOrganizationSettingsRow(
      null,
      snapshot,
    ).capabilities;
    expect(Object.keys(capabilities)).toEqual(Object.keys(FEATURE_REGISTRY));
    expect(JSON.stringify(capabilities)).not.toContain("proof");
  }
});

describe.serial("undeclared feature deployment discovery", () => {
  test("the server reports the deployment decision with an empty declaration list", () => {
    const previous = env.FEATURE_LEGAL_LISTS;
    const restoreRuntimeMode = setRuntimeModeForTesting({
      mode: RUNTIME_MODE.strict,
    });
    try {
      for (const enabled of [false, true]) {
        env.FEATURE_LEGAL_LISTS = enabled;
        const result = projectOrganizationSettingsRow(null, emptySnapshot);
        expect(result.declaredFeatureIds).toEqual([]);
        expect(result.capabilities).toEqual({});
        expect(result.deploymentFeatures.legalLists).toBe(enabled);
      }
    } finally {
      env.FEATURE_LEGAL_LISTS = previous;
      restoreRuntimeMode();
    }
  });
});
