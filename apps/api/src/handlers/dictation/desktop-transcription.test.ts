import { Result } from "better-result";
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import * as v from "valibot";

import {
  defaultTranscriptionModelId,
  isTranscriptionModelId,
  TRANSCRIPTION_MODELS,
} from "@stll/ai-catalog/transcription";
import {
  desktopDictationModelsSchema,
  MAX_DESKTOP_DICTATION_TRANSCRIPT_LENGTH,
} from "@stll/api-contract/desktop-dictation-transcription";
import { createTestState } from "@stll/test-state";

import { env } from "@/api/env";
import { makeWavAudioBytes } from "@/api/handlers/dictation/audio-fixtures.test-helper";
import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import type {
  loadOrgSettingsForAuth,
  OrgSettingsForAuth,
} from "@/api/lib/ai-config-loader";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { toSafeId } from "@/api/lib/branded-types";
import { buildFeatureAccessSnapshot } from "@/api/lib/feature-access/snapshot";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import type { withActionAdmission } from "@/api/lib/rate-limit/action-admission";
import {
  claimFixtureDeviceProof,
  createDesktopDeviceSigner,
} from "@/api/tests/helpers/desktop-device-proof";
import { serveForTest, type TestServer } from "@/api/tests/helpers/test-server";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import {
  createDesktopDictationModelsEndpoint,
  createDesktopDictationTranscribeEndpoint,
  listDictationModels,
} from "./desktop-transcription";
import type { DictationDependencies } from "./transcribe";

const testState = createTestState({ file: import.meta.path, config: env });

const servers: TestServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map(async (server) => await server.stop()));
});

const USER_ID = toSafeId<"user">("desktop-dictating-member");
const ORGANIZATION_ID = toSafeId<"organization">("desktop-dictating-firm");
const EMAIL = "desktop-dictation@example.test";
const OWN_OPENROUTER = asTestRaw<OrgSettingsForAuth["orgAIConfig"]>({
  providers: [{ provider: "openrouter", apiKey: "own-key" }],
});
const OWN_OTHER_PROVIDER = asTestRaw<OrgSettingsForAuth["orgAIConfig"]>({
  providers: [{ provider: "anthropic", apiKey: "own-key" }],
});

const GRANT = {
  type: "member",
  organizationId: ORGANIZATION_ID,
  email: EMAIL,
} as const;

beforeEach(() => {
  testState.setConfig("API_FEATURE_ACCESS_GRANTS", {
    "desktop-dictation": [GRANT],
    "desktop-dictation-cloud": [GRANT],
  });
  testState.setConfig("DEMO_ACCOUNT_EMAIL", undefined);
});

/** Dictation stays granted; only the cloud decision is withheld. */
const withholdCloud = () => {
  testState.setConfig("API_FEATURE_ACCESS_GRANTS", {
    "desktop-dictation": [GRANT],
  });
};

test("only the models offered in the organization's region are listed", () => {
  const listed = listDictationModels({
    orgAIConfig: null,
    managedAIResidency: "eu",
  });
  const offered = Object.keys(TRANSCRIPTION_MODELS)
    .filter(isTranscriptionModelId)
    .filter(
      (modelId) =>
        TRANSCRIPTION_MODELS[modelId].residency.eu.status === "available",
    );
  expect(offered.length).toBeGreaterThan(0);
  expect(listed.models.map(({ id }) => id)).toEqual(offered);
  expect(listed.defaultModelId).toBe(defaultTranscriptionModelId("eu") ?? null);
  expect(listed.unavailable).toBeNull();
  for (const { id, displayName } of listed.models) {
    expect(isTranscriptionModelId(id)).toBe(true);
    if (isTranscriptionModelId(id)) {
      expect(displayName).toBe(TRANSCRIPTION_MODELS[id].displayName);
    }
  }
  expect(JSON.stringify(listed)).not.toMatch(/price|usd/iu);
});

test("a region without a model and a provider that does not transcribe list nothing, with the reason", () => {
  // Read as a plain status: the catalog may offer no model in the region.
  const offeredIn = (status: string) => status === "available";
  const usOffers = Object.values(TRANSCRIPTION_MODELS).some(({ residency }) =>
    offeredIn(residency.us.status),
  );
  expect(
    listDictationModels({ orgAIConfig: null, managedAIResidency: "us" }),
  ).toEqual(
    usOffers
      ? expect.objectContaining({ unavailable: null })
      : { models: [], defaultModelId: null, unavailable: "region" },
  );
  expect(
    listDictationModels({ orgAIConfig: null, managedAIResidency: null }),
  ).toEqual({ models: [], defaultModelId: null, unavailable: "region" });
  expect(
    listDictationModels({
      orgAIConfig: OWN_OTHER_PROVIDER,
      managedAIResidency: "eu",
    }),
  ).toEqual({ models: [], defaultModelId: null, unavailable: "provider" });
  expect(
    listDictationModels({
      orgAIConfig: OWN_OPENROUTER,
      managedAIResidency: "eu",
    }).unavailable,
  ).toBeNull();
});

const authorizeAccount = async (request: Request) => {
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
        credential: "desktop-dictation-fixture",
      }),
      deviceJkt: device.deviceJkt,
      keyId: "linked-desktop",
      credential: "desktop-dictation-fixture",
    }),
    organizationId: ORGANIZATION_ID,
    userId: USER_ID,
    keyId: "linked-desktop",
    memberRole: sessionMemberRole("member"),
    scopedDb,
  });
};

const loadSettings = asTestRaw<typeof loadOrgSettingsForAuth>(
  async () =>
    await Promise.resolve({
      orgAIConfig: null,
      orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
      promptCachingEnabled: false,
      managedAIResidency: "eu",
    }),
);

const serveApp = (app: ReturnType<typeof createHttpApp>) => {
  const server = serveForTest(app);
  servers.push(server);
  return server;
};

const serveModels = (
  endpoint: ReturnType<typeof createDesktopDictationModelsEndpoint>,
) =>
  serveApp(
    createHttpApp({
      middleware: [errorBoundary],
      routes: routes({ "/models": { GET: endpoint } }),
    }),
  );

const serveTranscribe = (
  endpoint: ReturnType<typeof createDesktopDictationTranscribeEndpoint>,
) =>
  serveApp(
    createHttpApp({
      middleware: [errorBoundary],
      routes: routes({ "/transcribe": { POST: endpoint } }),
    }),
  );

test("a granted desktop reads its region's models", async () => {
  const server = serveModels(
    createDesktopDictationModelsEndpoint({ authorizeAccount, loadSettings }),
  );
  const response = await server.fetch(new Request("http://localhost/models"));
  expect(response.status).toBe(200);
  expect(v.parse(desktopDictationModelsSchema, await response.json())).toEqual(
    listDictationModels({ orgAIConfig: null, managedAIResidency: "eu" }),
  );
});

test.each([
  [
    "without any dictation decision",
    () => {
      testState.setConfig("API_FEATURE_ACCESS_GRANTS", {});
    },
  ],
  ["with local dictation only", withholdCloud],
])("a desktop %s reads no models", async (_case, withhold) => {
  withhold();
  const settings = mock(loadSettings);
  const server = serveModels(
    createDesktopDictationModelsEndpoint({
      authorizeAccount,
      loadSettings: settings,
    }),
  );
  const response = await server.fetch(new Request("http://localhost/models"));
  expect(response.status).toBe(403);
  expect(settings).not.toHaveBeenCalled();
});

const exerciseTranscribe = async ({
  withhold = () => undefined,
  email = EMAIL,
  text = "Dobrý den.",
}: { withhold?: () => void; email?: string | null; text?: string } = {}) => {
  withhold();
  const transcribe = mock(
    async (options: Parameters<DictationDependencies["transcribe"]>[0]) =>
      await Promise.resolve(
        Result.ok({
          transcript: {
            text,
            segments: [],
            detectedLanguage: options.language ?? null,
            durationMs: 1234,
            modelId: options.modelId,
            vocabulary: "not-supported" as const,
          },
          admittedDurationMs: 1234,
        }),
      ),
  );
  const endpoint = createDesktopDictationTranscribeEndpoint({
    authorizeAccount,
    loadSettings,
    readAccountEmail: async () => await Promise.resolve(email),
    dependencies: asTestRaw<Partial<DictationDependencies>>({
      transcribe,
      credential: async () => await Promise.resolve(Result.ok({ apiKey: "k" })),
      limit: async () => await Promise.resolve(Result.ok(undefined)),
      preflight: async () => await Promise.resolve(Result.ok(undefined)),
      settle: async () => await Promise.resolve(Result.ok(undefined)),
    }),
    admit: asTestRaw<typeof withActionAdmission>(
      async ({ run }: Parameters<typeof withActionAdmission>[0]) =>
        Result.ok(
          await run(new AbortController().signal, {
            reservePeriod: async () => Result.ok(undefined),
          }),
        ),
    ),
  });
  const server = serveTranscribe(endpoint);
  const form = new FormData();
  form.set(
    "file",
    new File([makeWavAudioBytes(1234)], "dictation.wav", {
      type: "audio/wav",
    }),
  );
  form.set("language", "cs");
  const response = await server.fetch(
    new Request("http://localhost/transcribe", { method: "POST", body: form }),
  );
  return { response, transcribe };
};

test("a granted desktop's audio is transcribed with the region's default model and its language", async () => {
  const { response, transcribe } = await exerciseTranscribe();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ text: "Dobrý den." });
  expect(transcribe.mock.calls.at(0)?.[0]).toMatchObject({
    modelId: defaultTranscriptionModelId("eu"),
    language: "cs",
  });
});

test("a transcript longer than its answer allows is refused, not answered", async () => {
  const longest = "a".repeat(MAX_DESKTOP_DICTATION_TRANSCRIPT_LENGTH);
  const kept = await exerciseTranscribe({ text: longest });
  expect(kept.response.status).toBe(200);
  expect(await kept.response.json()).toEqual({ text: longest });

  const { response } = await exerciseTranscribe({ text: `${longest}a` });
  expect(response.status).toBe(502);
  expect(JSON.stringify(await response.json())).not.toContain(longest);
});

test.each([
  [
    "without any dictation decision",
    () => {
      testState.setConfig("API_FEATURE_ACCESS_GRANTS", {});
    },
  ],
  ["with local dictation only", withholdCloud],
])("a desktop %s cannot transcribe", async (_case, withhold) => {
  const { response, transcribe } = await exerciseTranscribe({ withhold });
  expect(response.status).toBe(403);
  expect(transcribe).not.toHaveBeenCalled();
});

test("the sandbox demo account never transcribes audio from a linked desktop", async () => {
  const { response, transcribe } = await exerciseTranscribe({
    withhold: () => {
      testState.setConfig("DEMO_ACCOUNT_EMAIL", EMAIL);
    },
  });
  expect(response.status).toBe(403);
  expect(transcribe).not.toHaveBeenCalled();
});

test("a linked account that no longer exists never transcribes", async () => {
  const { response, transcribe } = await exerciseTranscribe({ email: null });
  expect(response.status).toBe(403);
  expect(transcribe).not.toHaveBeenCalled();
});
