import { Result } from "better-result";
import { afterAll, beforeEach, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";

import { DESKTOP_BILLING_DRAFT_REFUSAL_CODE } from "@stll/api-contract/desktop-billing-drafts";
import { createTestState } from "@stll/test-state";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  billingDraftUserSettings,
  organizationSettings,
} from "@/api/db/schema";
import { createMembershipScopedDb } from "@/api/db/scoped";
import { env } from "@/api/env";
import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type { SafeId } from "@/api/lib/branded-types";
import { buildFeatureAccessSnapshot } from "@/api/lib/feature-access/snapshot";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import type { withActionAdmission } from "@/api/lib/rate-limit/action-admission";
import type {
  DispatchCheck,
  generateTanStackObjectForTask,
  generateTanStackTextForTask,
} from "@/api/lib/tanstack-ai-generate";
import { MANAGED_MODEL_TIER } from "@/api/lib/usage/managed-model-tier";
import { createDesktopBillingDraftRequest } from "@/api/tests/helpers/desktop-billing-draft";
import {
  claimFixtureDeviceProof,
  createDesktopDeviceSigner,
} from "@/api/tests/helpers/desktop-device-proof";
import { runDispatchCheck } from "@/api/tests/helpers/dispatch-check";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import { serveForTest } from "@/api/tests/helpers/test-server";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";

import { createDesktopBillingDraftEndpoint } from "./billing-drafts";
import { createDesktopTimeEntryNarrativeEndpoint } from "./narrative";
import { generateDesktopTimeEntryNarrative } from "./narrative-model";

// The real gate, context and endpoints on the real database; the model is a
// generator that records a call only once the gate let its request leave.

const testState = createTestState({ file: import.meta.path, config: env });
const ids = createTestIds();
let db: Awaited<ReturnType<typeof getTestDb>>;

testState.beforeAll(async () => {
  testState.setConfig("FEATURE_TIME_BILLING", true);
  testState.setConfig("API_FEATURE_ACCESS_GRANTS", {
    "activity-timeline": [{ type: "organization", organizationId: ids.orgA }],
  });
  db = await getTestDb();
  await setupRlsTestData(db, ids);
});

beforeEach(async () => {
  await db
    .update(organizationSettings)
    .set({ aiBillingDraftsMode: "enabled" })
    .where(eq(organizationSettings.organizationId, ids.orgA));
  await db
    .delete(billingDraftUserSettings)
    .where(inArray(billingDraftUserSettings.organizationId, [ids.orgA]));
  await db.insert(billingDraftUserSettings).values({
    organizationId: ids.orgA,
    userId: ids.userA1,
    consentAt: new Date("2026-10-01T12:00:00Z"),
  });
});

afterAll(async () => {
  await releaseTestDb();
});

const withdrawConsent = async () => {
  await db
    .update(billingDraftUserSettings)
    .set({ consentAt: null })
    .where(
      and(
        eq(billingDraftUserSettings.organizationId, ids.orgA),
        eq(billingDraftUserSettings.userId, ids.userA1),
      ),
    );
};

const switchOff = async () => {
  await db
    .update(organizationSettings)
    .set({ aiBillingDraftsMode: "disabled" })
    .where(eq(organizationSettings.organizationId, ids.orgA));
};

/** Member A1 of organization A, linked through a desktop credential. */
const authorizeAccount = async (request: Request) => {
  const organizationId: SafeId<"organization"> = ids.orgA;
  const userId: SafeId<"user"> = ids.userA1;
  const device = await createDesktopDeviceSigner();
  return Result.ok({
    featureAccessSnapshot: buildFeatureAccessSnapshot({
      organizationId,
      userId,
      identity: { email: `${userId}@example.test`, emailVerified: true },
      enrolments: [{ featureId: "time-billing", organizationId, userId }],
    }),
    consumedProof: await claimFixtureDeviceProof({
      request: await device.signRequest({
        request,
        credential: "drafting-gate-fixture",
      }),
      deviceJkt: device.deviceJkt,
      keyId: "linked-desktop",
      credential: "drafting-gate-fixture",
    }),
    organizationId,
    userId,
    keyId: "linked-desktop",
    memberRole: sessionMemberRole("member"),
    scopedDb: asTestRaw<ScopedDb>(
      createMembershipScopedDb(db, {
        organizationId,
        userId,
        serverValidatedWorkspaceIds: [],
      }),
    ),
  });
};

const post = async (
  endpoint:
    | ReturnType<typeof createDesktopBillingDraftEndpoint>
    | ReturnType<typeof createDesktopTimeEntryNarrativeEndpoint>,
  body: unknown,
) => {
  await using server = serveForTest(
    createHttpApp({
      middleware: [errorBoundary],
      routes: routes({ "/route": { POST: endpoint } }),
    }),
  );
  const response = await server.fetch(
    new Request("http://localhost/route", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const answer: unknown = await response.json();
  return { status: response.status, body: answer };
};

type ModelOptions = { beforeEachDispatch?: DispatchCheck | undefined };

/** A model that fails the test's expectation by being reached at all: it
 * counts a request only once the gate let it leave. */
const unreachableModel = () => {
  const sent: unknown[] = [];
  const generate = async (options: ModelOptions) => {
    await runDispatchCheck(options.beforeEachDispatch);
    sent.push(options);
    throw new Error("The model must not be reached");
  };
  return { sent, generate };
};

const draftEndpoint = ({
  generate,
  beforeRun,
}: {
  generate: (options: ModelOptions) => Promise<never>;
  beforeRun?: () => Promise<void>;
}) =>
  createDesktopBillingDraftEndpoint({
    authorizeAccount,
    generateObjectForTask:
      asTestRaw<typeof generateTanStackObjectForTask>(generate),
    admit: asTestRaw<typeof withActionAdmission>(
      async ({ run }: Parameters<typeof withActionAdmission>[0]) => {
        await beforeRun?.();
        return Result.ok(
          await run(new AbortController().signal, {
            reservePeriod: async () => Result.ok(undefined),
          }),
        );
      },
    ),
  });

const draftBody = () =>
  createDesktopBillingDraftRequest({ matterId: ids.wsA1 });

test("drafting refuses an organization switched off and a member without consent before the model", async () => {
  for (const [prepare, code] of [
    [switchOff, DESKTOP_BILLING_DRAFT_REFUSAL_CODE.organizationOff],
    [withdrawConsent, DESKTOP_BILLING_DRAFT_REFUSAL_CODE.consentRequired],
  ] as const) {
    await prepare();
    const model = unreachableModel();
    const answer = await post(
      draftEndpoint({ generate: model.generate }),
      draftBody(),
    );
    expect(answer).toMatchObject({ status: 403, body: { code } });
    expect(model.sent).toEqual([]);
    await db
      .update(organizationSettings)
      .set({ aiBillingDraftsMode: "enabled" })
      .where(eq(organizationSettings.organizationId, ids.orgA));
  }
});

test("a consent withdrawn after the context loaded stops the drafting request", async () => {
  const model = unreachableModel();
  const answer = await post(
    draftEndpoint({ generate: model.generate, beforeRun: withdrawConsent }),
    draftBody(),
  );
  expect(answer).toMatchObject({
    status: 403,
    body: { code: DESKTOP_BILLING_DRAFT_REFUSAL_CODE.consentRequired },
  });
  expect(model.sent).toEqual([]);
});

const narrativeEndpoint = ({
  generate,
  beforeRun,
}: {
  generate: (options: ModelOptions) => Promise<never>;
  beforeRun?: () => Promise<void>;
}) =>
  createDesktopTimeEntryNarrativeEndpoint({
    authorizeAccount,
    narrate: async ({ account, drafting, request, signal }) => {
      await beforeRun?.();
      const admission = testModelAdmission(
        account.organizationId,
        "desktop-time-entries.narrative",
      );
      return await generateDesktopTimeEntryNarrative(
        {
          request,
          drafting,
          admission,
          organizationId: account.organizationId,
          userId: account.userId,
          orgAIConfig: null,
          managedAIResidency: "eu",
          caching: { enabled: false, reason: "org-disabled" },
          analytics: createTanStackAIAnalyticsCallbacks({
            dataClass: "customer",
            feature: "desktop_time_entries.narrative",
            modelTier: MANAGED_MODEL_TIER.standard,
            organizationId: account.organizationId,
            traceId: "drafting-gate-db-test",
          }),
          abortSignal: signal,
        },
        asTestRaw<typeof generateTanStackTextForTask>(generate),
      );
    },
  });

const narrativeBody = {
  titles: ["Smlouva o dílo – návrh.docx"],
  locale: "cs-CZ",
  matterName: null,
};

test("the narrative route refuses an organization switched off and a member without consent before the model", async () => {
  for (const [prepare, code] of [
    [switchOff, DESKTOP_BILLING_DRAFT_REFUSAL_CODE.organizationOff],
    [withdrawConsent, DESKTOP_BILLING_DRAFT_REFUSAL_CODE.consentRequired],
  ] as const) {
    await prepare();
    const model = unreachableModel();
    const answer = await post(
      narrativeEndpoint({ generate: model.generate }),
      narrativeBody,
    );
    expect(answer).toMatchObject({ status: 403, body: { code } });
    expect(model.sent).toEqual([]);
    await db
      .update(organizationSettings)
      .set({ aiBillingDraftsMode: "enabled" })
      .where(eq(organizationSettings.organizationId, ids.orgA));
  }
});

test("a consent withdrawn after the narrative was admitted stops its request", async () => {
  const model = unreachableModel();
  const answer = await post(
    narrativeEndpoint({ generate: model.generate, beforeRun: withdrawConsent }),
    narrativeBody,
  );
  expect(answer).toMatchObject({
    status: 403,
    body: { code: DESKTOP_BILLING_DRAFT_REFUSAL_CODE.consentRequired },
  });
  expect(model.sent).toEqual([]);
});
