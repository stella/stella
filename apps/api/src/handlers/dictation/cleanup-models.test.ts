import { Result } from "better-result";
import { afterAll, beforeEach, expect, test } from "bun:test";
import * as v from "valibot";

import { BYOK_MODEL_OPTIONS, TANSTACK_AI_PROVIDERS } from "@stll/ai-catalog";
import type { BYOKProvider } from "@stll/ai-catalog";
import {
  DESKTOP_DICTATION_CLEANUP_LIMITS,
  desktopDictationCleanupModelsSchema,
} from "@stll/api-contract/desktop-dictation-cleanup";
import { createTestState } from "@stll/test-state";

import { env } from "@/api/env";
import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import type { loadOrgSettingsForAuth } from "@/api/lib/ai-config-loader";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { toSafeId } from "@/api/lib/branded-types";
import { getConfiguredChatModelOptions } from "@/api/lib/chat-model-selection";
import { buildFeatureAccessSnapshot } from "@/api/lib/feature-access/snapshot";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import {
  claimFixtureDeviceProof,
  createDesktopDeviceSigner,
} from "@/api/tests/helpers/desktop-device-proof";
import { serveForTest, type TestServer } from "@/api/tests/helpers/test-server";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import {
  createDesktopDictationCleanupModelsEndpoint,
  listDictationCleanupModels,
  resolveDictationCleanupModel,
} from "./cleanup-models";

const testState = createTestState({ file: import.meta.path, config: env });

const servers: TestServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map(async (server) => await server.stop()));
});

const USER_ID = toSafeId<"user">("cleanup-models-member");
const ORGANIZATION_ID = toSafeId<"organization">("cleanup-models-firm");
const EMAIL = "cleanup-models@example.test";
const GRANT = {
  type: "member",
  organizationId: ORGANIZATION_ID,
  email: EMAIL,
} as const;

beforeEach(() => {
  testState.setConfig("API_FEATURE_ACCESS_GRANTS", {
    "desktop-dictation": [GRANT],
  });
  testState.setConfig("DEMO_ACCOUNT_EMAIL", undefined);
});

/** An organization that brings its own key for each of `providers`. */
const ownProviders = (providers: readonly BYOKProvider[]): OrgAIConfig =>
  asTestRaw<OrgAIConfig>({
    providers: providers.map((provider) => ({
      provider,
      apiKey: "own-key",
    })),
  });

test("the cleanup list is the chat model picker's list for the organization's providers", () => {
  for (const providers of [
    ["anthropic"],
    ["openai", "anthropic"],
    ["openrouter"],
  ] as const) {
    const orgAIConfig = ownProviders(providers);
    const listed = listDictationCleanupModels(orgAIConfig);
    // The cleanup task offers every chat model, so the lists are one.
    expect(listed.models).toEqual(
      getConfiguredChatModelOptions(orgAIConfig).map(
        ({ value, displayName, provider }) => ({
          value,
          displayName,
          provider,
        }),
      ),
    );
    expect(listed.models.length).toBeGreaterThan(0);
    expect(
      listed.models.every(({ provider }) =>
        providers.some((own) => own === provider),
      ),
    ).toBe(true);
    expect(v.parse(desktopDictationCleanupModelsSchema, listed)).toEqual(
      listed,
    );
  }
});

test("every catalog model fits the contract's bounds, all providers at once", () => {
  const listed = listDictationCleanupModels(
    ownProviders(TANSTACK_AI_PROVIDERS),
  );
  const offered = TANSTACK_AI_PROVIDERS.reduce(
    (count, provider) => count + BYOK_MODEL_OPTIONS[provider].length,
    0,
  );
  expect(listed.models).toHaveLength(offered);
  expect(offered).toBeLessThanOrEqual(DESKTOP_DICTATION_CLEANUP_LIMITS.models);
  expect(v.safeParse(desktopDictationCleanupModelsSchema, listed).success).toBe(
    true,
  );
});

test("a model the organization offers is used; any other choice is automatic", () => {
  const anthropicOnly = ownProviders(["anthropic"]);
  const offered = listDictationCleanupModels(anthropicOnly).models.at(0);
  if (offered === undefined) {
    throw new TypeError("Expected an offered model");
  }
  expect(resolveDictationCleanupModel(offered.value, anthropicOnly)).toBe(
    offered.value,
  );
  // Automatic, the organization's fast model, needs no choice.
  expect(
    resolveDictationCleanupModel(undefined, anthropicOnly),
  ).toBeUndefined();
  const otherProvider = listDictationCleanupModels(
    ownProviders(["openai"]),
  ).models.at(0);
  if (otherProvider === undefined) {
    throw new TypeError("Expected an OpenAI model");
  }
  // A provider whose key the organization removed, a bare model id, a
  // model outside the catalog and an id in another encoding all fall back.
  for (const stale of [
    otherProvider.value,
    offered.value.split("::").at(1) ?? "",
    "anthropic::claude-retired-model",
    "anthropic:claude-sonnet",
  ]) {
    expect(resolveDictationCleanupModel(stale, anthropicOnly)).toBeUndefined();
  }
});

const authorizeAccount =
  (role: "member" | "external" = "member") =>
  async (request: Request) => {
    const device = await createDesktopDeviceSigner();
    const { scopedDb } = createScopedDbMock({});
    return Result.ok({
      featureAccessSnapshot: buildFeatureAccessSnapshot({
        organizationId: ORGANIZATION_ID,
        userId: USER_ID,
        identity: { email: EMAIL, emailVerified: true },
        enrolments: [],
      }),
      consumedProof: await claimFixtureDeviceProof({
        request: await device.signRequest({
          request,
          credential: "cleanup-models-fixture",
        }),
        deviceJkt: device.deviceJkt,
        keyId: "linked-desktop",
        credential: "cleanup-models-fixture",
      }),
      organizationId: ORGANIZATION_ID,
      userId: USER_ID,
      keyId: "linked-desktop",
      memberRole: sessionMemberRole(role),
      scopedDb,
    });
  };

const OWN_ANTHROPIC = ownProviders(["anthropic"]);

const loadSettings = asTestRaw<typeof loadOrgSettingsForAuth>(
  async () =>
    await Promise.resolve({
      orgAIConfig: OWN_ANTHROPIC,
      orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
      promptCachingEnabled: false,
      managedAIResidency: "eu",
    }),
);

const readModels = async (
  role: "member" | "external" = "member",
  settings: typeof loadOrgSettingsForAuth = loadSettings,
) => {
  const server = serveForTest(
    createHttpApp({
      middleware: [errorBoundary],
      routes: routes({
        "/cleanup-models": {
          GET: createDesktopDictationCleanupModelsEndpoint({
            authorizeAccount: authorizeAccount(role),
            loadSettings: settings,
          }),
        },
      }),
    }),
  );
  servers.push(server);
  return await server.fetch(new Request("http://localhost/cleanup-models"));
};

test("a desktop that may dictate reads its organization's cleanup models", async () => {
  const response = await readModels();
  expect(response.status).toBe(200);
  const body = v.parse(
    desktopDictationCleanupModelsSchema,
    await response.json(),
  );
  expect(body).toEqual(listDictationCleanupModels(OWN_ANTHROPIC));
  expect(JSON.stringify(body)).not.toContain("own-key");
});

test("a desktop without dictation, or a role that may not use AI, reads no models", async () => {
  expect((await readModels("external")).status).toBe(403);
  testState.setConfig("API_FEATURE_ACCESS_GRANTS", {});
  expect((await readModels()).status).toBe(403);
});

test("unreadable AI settings are refused rather than listed as no models", async () => {
  const response = await readModels(
    "member",
    asTestRaw<typeof loadOrgSettingsForAuth>(
      async () =>
        await Promise.resolve({
          orgAIConfig: null,
          orgAIConfigStatus: ORG_AI_CONFIG_STATUS.unreadable,
          promptCachingEnabled: null,
          managedAIResidency: null,
        }),
    ),
  );
  expect(response.status).toBeGreaterThanOrEqual(400);
});
