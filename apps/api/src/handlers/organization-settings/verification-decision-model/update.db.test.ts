import { panic } from "better-result";
import { afterAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import "@/api/tests/setup-env";

import { createTestState } from "@stll/test-state";

import { user } from "@/api/db/auth-schema";
import type { SafeDb } from "@/api/db/safe-db";
import { auditLogs, organizationSettings } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { env } from "@/api/env";
import readAIConfig from "@/api/handlers/organization-settings/read-ai-config";
import updateVerificationDecisionModel from "@/api/handlers/organization-settings/verification-decision-model/update";
import { HttpStatusResponse } from "@/api/http/status";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { encryptAIConfig } from "@/api/lib/ai-config-crypto";
import {
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { LIST_VERIFICATION_FEATURE_ID } from "@/api/lib/feature-access/registry";
import { readVerdictDecider } from "@/api/lib/lists/verification/verdict-decider-setting";
import {
  hasMemberPermission,
  sessionMemberRole,
} from "@/api/lib/permission-authorization";
import { organizationFeatureGrants } from "@/api/tests/helpers/feature-grants";
import {
  createTestHandlerContext,
  NO_AUDIT,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
let ids: TestIds;
const testState = createTestState({ file: import.meta.path, config: env });

const safeDbFor = (
  organizationId: SafeId<"organization">,
  userId: SafeId<"user">,
): SafeDb =>
  asTestRaw<SafeDb>(createSafeDb(testDb, [], organizationId, userId));

testState.beforeAll(async () => {
  // No instance decision model: only the organization's own can be used.
  testState.setConfig("TYPESAFE_API_KEY", undefined);
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
  // Feature access admits only a verified address; the shared fixture's
  // users have none, and the handler would answer as if it did not exist.
  await testDb
    .update(user)
    .set({ emailVerified: true })
    .where(eq(user.id, ids.userA1));
  // The switch belongs to Anchor Verification, which the organization has.
  testState.setConfig("FEATURE_LEGAL_LISTS", true);
  testState.setConfig(
    "API_FEATURE_ACCESS_GRANTS",
    organizationFeatureGrants(ids.orgA, [LIST_VERIFICATION_FEATURE_ID]),
  );
});

afterAll(releaseTestDb);

const save = async (enabled: boolean) =>
  await updateVerificationDecisionModel.handler(
    createTestHandlerContext<
      Parameters<typeof updateVerificationDecisionModel.handler>[0]
    >({
      audit: createBackgroundAuditRecorder({
        organizationId: ids.orgA,
        userId: ids.userA1,
        workspaceId: null,
        execution: {
          performer: { type: "user", id: ids.userA1 },
          trigger: { type: "system", source: "verification_decider_test" },
        },
      }),
      scopedDb: NO_DB,
      safeDb: safeDbFor(ids.orgA, ids.userA1),
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
      body: v.parse(updateVerificationDecisionModel.config.body, { enabled }),
    }),
  );

const read = async () => {
  const response = await readAIConfig.handler(
    createTestHandlerContext<Parameters<typeof readAIConfig.handler>[0]>({
      audit: NO_AUDIT,
      scopedDb: NO_DB,
      safeDb: safeDbFor(ids.orgA, ids.userA1),
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
    }),
  );
  return response instanceof HttpStatusResponse
    ? panic("The AI configuration could not be read")
    : response;
};

const storeAIConfig = async (config: OrgAIConfig | null) => {
  const encrypted =
    config === null ? null : await encryptAIConfig(ids.orgA, config);
  const stored = {
    aiConfigEncrypted: encrypted?.ciphertext ?? null,
    aiConfigIv: encrypted?.iv ?? null,
  };
  await testDb
    .insert(organizationSettings)
    .values({
      id: createSafeId<"organizationSettings">(),
      organizationId: ids.orgA,
      ...stored,
    })
    .onConflictDoUpdate({
      target: organizationSettings.organizationId,
      set: stored,
    });
};

const settingAudits = async () =>
  (
    await testDb
      .select({ changes: auditLogs.changes })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.organizationId, ids.orgA),
          eq(auditLogs.resourceType, AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS),
        ),
      )
  ).filter(
    ({ changes }) =>
      changes !== null &&
      Object.hasOwn(changes, "verificationDecisionModelEnabled"),
  );

const WITH_DECISION_MODEL = {
  providers: [{ provider: "openai", apiKey: "fixture-provider-key" }],
  overrideModels: null,
  decision: {
    provider: "typesafe",
    apiKey: "fixture-decision-key",
    modelId: "jev-latest",
  },
} satisfies OrgAIConfig;

describe("the organization's decision model for verification verdicts", () => {
  test("only an administrator may set it, and only to on or off", () => {
    for (const role of ["owner", "admin"] as const) {
      expect(
        hasMemberPermission(
          sessionMemberRole(role),
          updateVerificationDecisionModel.config.permissions,
        ),
      ).toBe(true);
    }
    for (const role of ["member", "intern", "external"] as const) {
      expect(
        hasMemberPermission(
          sessionMemberRole(role),
          updateVerificationDecisionModel.config.permissions,
        ),
      ).toBe(false);
    }
    expect(
      v.is(updateVerificationDecisionModel.config.body, { enabled: "yes" }),
    ).toBe(false);
  });

  test("is refused without a decision model, then saved, read back and audited once one exists", async () => {
    await testDb
      .delete(organizationSettings)
      .where(eq(organizationSettings.organizationId, ids.orgA));

    expect((await read()).verificationDecisionModel).toEqual({
      enabled: false,
      available: false,
    });
    const refused = await save(true);
    expect(refused).toBeInstanceOf(HttpStatusResponse);
    expect(
      refused instanceof HttpStatusResponse
        ? { status: refused.code, body: JSON.stringify(refused.response) }
        : null,
    ).toMatchObject({
      status: 409,
      body: expect.stringContaining("verification_decision_model_unavailable"),
    });
    expect((await read()).verificationDecisionModel.enabled).toBe(false);
    expect(await settingAudits()).toHaveLength(0);

    await storeAIConfig(WITH_DECISION_MODEL);
    expect((await read()).verificationDecisionModel).toEqual({
      enabled: false,
      available: true,
    });
    expect(await save(true)).toEqual({ enabled: true });
    expect((await read()).verificationDecisionModel).toEqual({
      enabled: true,
      available: true,
    });
    // Saving the same value again records nothing new.
    expect(await save(true)).toEqual({ enabled: true });
    expect(await settingAudits()).toEqual([
      {
        changes: {
          verificationDecisionModelEnabled: { old: false, new: true },
        },
      },
    ]);

    // A run now asks the organization's decision model.
    const decider = await testDb.transaction(
      async (tx) =>
        await readVerdictDecider(asTestRaw(tx), {
          organizationId: ids.orgA,
          orgAIConfig: WITH_DECISION_MODEL,
        }),
    );
    expect(decider.kind).toBe("decision-model");
    expect(
      decider.kind === "decision-model" ? decider.model?.keySource : null,
    ).toBe("byok");
  });

  test("stays switchable off after the decision model is removed", async () => {
    await storeAIConfig(null);
    expect((await read()).verificationDecisionModel).toEqual({
      enabled: true,
      available: false,
    });
    expect(await save(false)).toEqual({ enabled: false });
    expect((await read()).verificationDecisionModel).toEqual({
      enabled: false,
      available: false,
    });
  });
});
