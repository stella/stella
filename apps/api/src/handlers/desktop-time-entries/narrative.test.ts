import { Result } from "better-result";
import { expect, test } from "bun:test";

import { AI_FAILURE_CODES } from "@stll/api-contract";
import { DESKTOP_BILLING_DRAFT_REFUSAL_CODE } from "@stll/api-contract/desktop-billing-drafts";
import { DESKTOP_TIME_ENTRY_NARRATIVE_MAX_LENGTH } from "@stll/api-contract/desktop-time-entries";
import { createTestState } from "@stll/test-state";

import { env } from "@/api/env";
import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import { toSafeId } from "@/api/lib/branded-types";
import { buildFeatureAccessSnapshot } from "@/api/lib/feature-access/snapshot";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import {
  authorizedMemberRole,
  sessionMemberRole,
} from "@/api/lib/permission-authorization";
import type { generateTanStackTextForTask } from "@/api/lib/tanstack-ai-generate";
import { MANAGED_MODEL_TIER } from "@/api/lib/usage/managed-model-tier";
import {
  claimFixtureDeviceProof,
  createDesktopDeviceSigner,
} from "@/api/tests/helpers/desktop-device-proof";
import { runDispatchCheck } from "@/api/tests/helpers/dispatch-check";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import { serveForTest } from "@/api/tests/helpers/test-server";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import type { BillingDraftGate } from "./billing-draft-mode";
import { admitDraftingWithGateReader } from "./drafting-model";
import { createDesktopTimeEntryNarrativeEndpoint } from "./narrative";
import {
  type DesktopTimeEntryNarrativeRun,
  generateDesktopTimeEntryNarrative,
  NARRATIVE_FAILURE_MESSAGE,
} from "./narrative-model";

const testState = createTestState({ file: import.meta.path, config: env });
const ORGANIZATION_ID = "org_test";
const USER_ID = "user_test";
const CONTRACT_TITLE = "Smlouva o dílo – návrh.docx";
const LAND_REGISTRY_TITLE = "Katastr nemovitostí";
const TITLES = [CONTRACT_TITLE, LAND_REGISTRY_TITLE];
const MATTER_NAME = "Kupní smlouva – pozemek";
const BODY = { titles: TITLES, locale: "cs-CZ", matterName: MATTER_NAME };

type GenerateOptions = Parameters<typeof generateTanStackTextForTask>[0];

// The provider call is the only fake: the endpoint, authorization, prompt,
// failure mapping, cap and analytics callbacks are the real ones.
const narrateWith =
  (
    generate: (options: GenerateOptions) => Promise<string>,
  ): DesktopTimeEntryNarrativeRun =>
  async ({
    account: { organizationId, userId },
    drafting,
    request,
    signal,
  }) => {
    const admission = testModelAdmission(
      organizationId,
      "desktop-time-entries.narrative",
    );
    return await generateDesktopTimeEntryNarrative(
      {
        request,
        drafting,
        admission,
        organizationId,
        userId,
        orgAIConfig: null,
        managedAIResidency: "eu",
        caching: { enabled: false, reason: "org-disabled" },
        analytics: createTanStackAIAnalyticsCallbacks({
          dataClass: "customer",
          feature: "desktop_time_entries.narrative",
          modelTier: MANAGED_MODEL_TIER.standard,
          organizationId,
          traceId: "desktop-narrative-test",
        }),
        abortSignal: signal,
      },
      generate,
    );
  };

type ExerciseOptions = {
  hidden?: "activity-timeline" | "time-billing";
  denied?: boolean;
  body?: unknown;
  answer?: (options: GenerateOptions) => Promise<string>;
  /** What each successive gate read answers; the last one repeats. */
  gates?: readonly BillingDraftGate[];
};

const consenting: BillingDraftGate = {
  organizationMode: "enabled",
  consentAt: new Date("2026-10-01T12:00:00Z"),
  preference: null,
  draftingMode: "plain",
};

const exercise = async ({
  hidden,
  denied,
  body = BODY,
  answer = async () => await Promise.resolve("Revize smlouvy o dílo."),
  gates = [consenting],
}: ExerciseOptions) => {
  const calls: GenerateOptions[] = [];
  let gateReads = 0;
  const { scopedDb } = createScopedDbMock({});
  const device = await createDesktopDeviceSigner();
  const authorizeAccount = async (request: Request) =>
    Result.ok({
      // Built per request, after the grants below are configured.
      featureAccessSnapshot: buildFeatureAccessSnapshot({
        organizationId: toSafeId<"organization">(ORGANIZATION_ID),
        userId: USER_ID,
        identity: { email: "desktop@example.test", emailVerified: true },
        enrolments:
          hidden === "time-billing"
            ? []
            : [
                {
                  featureId: "time-billing",
                  organizationId: ORGANIZATION_ID,
                  userId: USER_ID,
                },
              ],
      }),
      consumedProof: await claimFixtureDeviceProof({
        request: await device.signRequest({
          request,
          credential: "fixture-credential",
        }),
        deviceJkt: device.deviceJkt,
        keyId: "desktop-key",
        credential: "fixture-credential",
      }),
      scopedDb,
      organizationId: toSafeId<"organization">(ORGANIZATION_ID),
      userId: toSafeId<"user">(USER_ID),
      keyId: "desktop-key",
      memberRole: denied
        ? authorizedMemberRole({
            role: "member",
            credential: {
              type: "attenuated",
              permissions: { timeEntry: ["read"] },
            },
          })
        : sessionMemberRole("member"),
    });
  const endpoint = createDesktopTimeEntryNarrativeEndpoint({
    authorizeAccount,
    admitDrafting: async (account) =>
      await admitDraftingWithGateReader({
        ...account,
        loadGate: async () => {
          const gate = gates.at(Math.min(gateReads, gates.length - 1));
          gateReads += 1;
          return await Promise.resolve(Result.ok(gate ?? consenting));
        },
      }),
    // The real generation calls the dispatch hook before each request.
    narrate: narrateWith(async (options) => {
      await runDispatchCheck(options.beforeEachDispatch);
      calls.push(options);
      return await answer(options);
    }),
  });
  await using server = serveForTest(
    createHttpApp({
      routes: routes(
        { "/time-entries/narrative": { POST: endpoint } },
        { prefix: "/v1/desktop" },
      ),
      middleware: [errorBoundary],
    }),
  );
  testState.setConfig("FEATURE_TIME_BILLING", true);
  testState.setConfig("API_FEATURE_ACCESS_GRANTS", {
    "activity-timeline":
      hidden === "activity-timeline"
        ? []
        : [
            {
              type: "member",
              organizationId: toSafeId<"organization">(ORGANIZATION_ID),
              email: "desktop@example.test",
            },
          ],
  });
  const response = await server.fetch(
    new Request("http://localhost/v1/desktop/time-entries/narrative", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return {
    status: response.status,
    text: await response.text(),
    calls,
    gateReads,
  };
};

const PRIVILEGED_TEXT = [...TITLES, MATTER_NAME, "Smlouva", "Katastr"];

const leakedIn = (serialized: string) =>
  PRIVILEGED_TEXT.filter((text) => serialized.includes(text));

test("either hidden feature or a missing create permission refuses before any model call", async () => {
  for (const hidden of ["activity-timeline", "time-billing"] as const) {
    const result = await exercise({ hidden });
    expect(result.status).toBe(403);
    expect(result.calls).toEqual([]);
  }
  const denied = await exercise({ denied: true });
  expect(denied.status).toBe(403);
  expect(denied.calls).toEqual([]);
});

test("the organization's switch and the member's consent refuse before any model call", async () => {
  for (const [gate, code] of [
    [
      { ...consenting, organizationMode: "disabled" },
      DESKTOP_BILLING_DRAFT_REFUSAL_CODE.organizationOff,
    ],
    [
      { ...consenting, consentAt: null },
      DESKTOP_BILLING_DRAFT_REFUSAL_CODE.consentRequired,
    ],
  ] as const) {
    const result = await exercise({ gates: [gate] });
    expect(result.status).toBe(403);
    expect(JSON.parse(result.text)).toMatchObject({ code });
    expect(result.calls).toEqual([]);
    expect(leakedIn(result.text)).toEqual([]);
  }
});

test("a consent withdrawn before a retried request stops that request", async () => {
  const withdrawn = { ...consenting, consentAt: null };
  // Admitted, then the first request goes out; the provider asks for a retry
  // and consent is gone by the time the second one would leave.
  const result = await exercise({
    gates: [consenting, consenting, withdrawn],
    answer: async (options) => {
      await runDispatchCheck(options.beforeEachDispatch);
      return "Revize smlouvy o dílo.";
    },
  });
  expect(result.status).toBe(403);
  expect(JSON.parse(result.text)).toMatchObject({
    code: DESKTOP_BILLING_DRAFT_REFUSAL_CODE.consentRequired,
  });
  expect(result.calls).toHaveLength(1);
  expect(result.gateReads).toBe(3);
});

test("over-limit and unknown input is rejected at the schema without echoing titles", async () => {
  for (const body of [
    { ...BODY, titles: [] },
    { ...BODY, titles: Array.from({ length: 41 }, () => CONTRACT_TITLE) },
    { ...BODY, titles: [LAND_REGISTRY_TITLE.repeat(20)] },
    { ...BODY, titles: ["   "] },
    { ...BODY, locale: "cs_CZ" },
    { ...BODY, matterName: MATTER_NAME.repeat(10) },
    { ...BODY, appName: CONTRACT_TITLE },
    { titles: TITLES, locale: "cs-CZ" },
  ]) {
    const result = await exercise({ body });
    expect(result.status).toBe(422);
    expect(result.calls).toEqual([]);
    expect(leakedIn(result.text)).toEqual([]);
  }
});

test("the requested locale, matter name and trimmed titles reach the model as data", async () => {
  const result = await exercise({
    body: {
      titles: ["  Katastr nemovitostí "],
      locale: "pt-BR",
      matterName: null,
    },
    answer: async () => await Promise.resolve("  Consulta ao cadastro.  "),
  });
  expect(result.status).toBe(200);
  expect(JSON.parse(result.text)).toEqual({
    narrative: "Consulta ao cadastro.",
  });
  expect(result.calls).toHaveLength(1);
  const call = result.calls.at(0);
  expect(call?.messages).toEqual([
    {
      role: "user",
      content: JSON.stringify({
        locale: "pt-BR",
        matterName: null,
        windowTitles: ["Katastr nemovitostí"],
      }),
    },
  ]);
  expect(call).toMatchObject({
    dataClass: "customer",
    task: "short-text",
    finishPolicy: "require-complete",
    systemPromptOrigin: "server-built",
    tenantWorkspaceIds: [],
  });
  expect(call?.maxOutputTokens).toBeLessThanOrEqual(512);
  expect(call?.system).not.toContain("Katastr");
});

test("a narrative longer than the entry limit is capped", async () => {
  const result = await exercise({
    answer: async () =>
      await Promise.resolve(
        "n".repeat(DESKTOP_TIME_ENTRY_NARRATIVE_MAX_LENGTH + 50),
      ),
  });
  expect(result.status).toBe(200);
  expect(JSON.parse(result.text)).toEqual({
    narrative: "n".repeat(DESKTOP_TIME_ENTRY_NARRATIVE_MAX_LENGTH),
  });
});

test("a model failure answers a typed 502 and no response, log or event carries the titles", async () => {
  const analytics = installRecordingAnalytics();
  const logs = installRecordingLogger();
  try {
    for (const [answer, code] of [
      [
        // A provider error that echoes the prompt it was sent.
        async () =>
          await Promise.reject(
            new Error(`Upstream rejected: ${JSON.stringify(BODY)}`, {
              cause: { body: BODY },
            }),
          ),
        AI_FAILURE_CODES.unknown,
      ],
      [
        async () => await Promise.resolve("   "),
        AI_FAILURE_CODES.empty_completion,
      ],
    ] as const) {
      const result = await exercise({ answer });
      expect(result.status).toBe(502);
      expect(JSON.parse(result.text)).toMatchObject({
        message: NARRATIVE_FAILURE_MESSAGE,
        code,
      });
      expect(leakedIn(result.text)).toEqual([]);
    }
    // The failure did reach both sinks; neither carries privileged text.
    expect(logs.records.length).toBeGreaterThan(0);
    expect(analytics.events.length).toBeGreaterThan(0);
    expect(leakedIn(JSON.stringify(logs.records))).toEqual([]);
    expect(leakedIn(JSON.stringify(analytics.events))).toEqual([]);
  } finally {
    logs.restore();
    analytics.restore();
  }
});
