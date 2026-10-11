import { describe, expect, test } from "bun:test";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import {
  DEFAULT_DOCUMENT_PROCESSING_MODE,
  DEFAULT_TIME_EDIT_WINDOW_DAYS,
  DEFAULT_TIME_MINIMUM_UNIT_MINUTES,
  DEFAULT_TIME_NARRATIVE_REQUIRED,
} from "@/api/db/schema";
import { env } from "@/api/env";
import readOrganizationSettings, {
  projectOrganizationSettingsRow,
} from "@/api/handlers/organization-settings/get";
import { resolveFeatureAccessSnapshot } from "@/api/lib/auth/feature-access/context";
import { toSafeId } from "@/api/lib/branded-types";
import { DEFAULT_MANAGED_AI_RESIDENCY } from "@/api/lib/chat/ai-data-policy";
import { createFeatureAccessSnapshot } from "@/api/lib/feature-access/policy";
import {
  FEATURE_REGISTRY,
  LIST_VERIFICATION_FEATURE_ID,
  LEGAL_LISTS_FEATURE_ID,
} from "@/api/lib/feature-access/registry";
import type { FeatureRegistry } from "@/api/lib/feature-access/registry";
import {
  DEFAULT_MATTER_NUMBER_PADDING,
  DEFAULT_MATTER_NUMBER_PATTERN,
} from "@/api/lib/matter-reference";
import { isMcpDescriptorFeatureEnabled } from "@/api/mcp/feature-access";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import {
  NO_AUDIT,
  createTestHandlerContext,
} from "@/api/tests/helpers/handler-context";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const defaultSettingsRow = {
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  documentProcessingMode: DEFAULT_DOCUMENT_PROCESSING_MODE,
  matterNumberPadding: DEFAULT_MATTER_NUMBER_PADDING,
  matterNumberPattern: DEFAULT_MATTER_NUMBER_PATTERN,
  practiceJurisdictions: [],
  promptCachingEnabled: true,
  managedAIResidency: DEFAULT_MANAGED_AI_RESIDENCY,
  memoryExtractionEnabled: false,
  timeMinimumUnitMinutes: DEFAULT_TIME_MINIMUM_UNIT_MINUTES,
  timeEditWindowDays: DEFAULT_TIME_EDIT_WINDOW_DAYS,
  timeLockedThroughMonth: null,
  timeNarrativeRequired: DEFAULT_TIME_NARRATIVE_REQUIRED,
  timeZone: null,
} satisfies Parameters<typeof projectOrganizationSettingsRow>[0];

const emptySnapshot = createFeatureAccessSnapshot({
  organizationId: "org_test",
  userId: "user_test",
  decisions: new Map(),
});

// Identity resolves through the member join; the enrolment read finds no rows.
const unenrolledSettingsDatabase = (email: string) =>
  createScopedDbMock(
    {
      query: {
        organizationSettings: { findFirst: async () => defaultSettingsRow },
      },
    },
    { featureAccess: { identity: { email, emailVerified: true } } },
  );

describe("projectOrganizationSettingsRow", () => {
  test("returns the active org's practiceJurisdictions verbatim", () => {
    const result = projectOrganizationSettingsRow(
      {
        updatedAt: defaultSettingsRow.updatedAt,
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

  test("projects the initialized settings defaults and their update token", () => {
    expect(
      projectOrganizationSettingsRow(defaultSettingsRow, emptySnapshot),
    ).toMatchObject({
      updatedAt: defaultSettingsRow.updatedAt.toISOString(),
      practiceJurisdictions: [],
      documentProcessingMode: "off",
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
        audit: NO_AUDIT,
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
    const projected = projectOrganizationSettingsRow(
      defaultSettingsRow,
      snapshot,
    );
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
      audit: NO_AUDIT,
      safeDb: database.safeDb,
      scopedDb: database.scopedDb,
    }),
  );
  expect(result).toMatchObject({
    capabilities: Object.fromEntries(
      Object.keys(FEATURE_REGISTRY)
        .filter((featureId) => featureId !== LIST_VERIFICATION_FEATURE_ID)
        .map((featureId) => [featureId, { status: "hidden" }]),
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
  expect(
    projectOrganizationSettingsRow(defaultSettingsRow, snapshot).capabilities,
  ).toEqual({
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
        audit: NO_AUDIT,
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
        Object.keys(FEATURE_REGISTRY)
          .filter((featureId) => featureId !== LIST_VERIFICATION_FEATURE_ID)
          .map((featureId) => [featureId, { status: "hidden" }]),
      ),
    });
    expect(result).not.toHaveProperty("capabilities.fixture-invitation");
  }
});

test("organization settings project the production verification declaration for granted and ungranted current members", async () => {
  const organizationId = toSafeId<"organization">("org_test");
  for (const granted of [false, true]) {
    const database = createScopedDbMock(
      {
        query: {
          organizationSettings: { findFirst: async () => defaultSettingsRow },
        },
      },
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
        audit: NO_AUDIT,
        safeDb: database.safeDb,
        scopedDb: database.scopedDb,
        featureAccessSnapshot: snapshot,
      }),
    );
    if (granted) {
      expect(result).toMatchObject({
        capabilities: { [LIST_VERIFICATION_FEATURE_ID]: { status: "enabled" } },
      });
    } else {
      expect(result).not.toHaveProperty(
        `capabilities.${LIST_VERIFICATION_FEATURE_ID}`,
      );
      expect(JSON.stringify(result)).not.toContain(
        LIST_VERIFICATION_FEATURE_ID,
      );
    }
    const capabilities = projectOrganizationSettingsRow(
      defaultSettingsRow,
      snapshot,
    ).capabilities;
    expect(Object.keys(capabilities)).toEqual(
      Object.keys(FEATURE_REGISTRY).filter(
        (featureId) => granted || featureId !== LIST_VERIFICATION_FEATURE_ID,
      ),
    );
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
        const result = projectOrganizationSettingsRow(
          defaultSettingsRow,
          emptySnapshot,
        );
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
