import { Result } from "better-result";
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import * as v from "valibot";

import {
  defaultTranscriptionModelId,
  isTranscriptionModelId,
  TRANSCRIPTION_MODELS,
} from "@stll/ai-catalog/transcription";
import { DESKTOP_DICTATION_UNTYPED_CHARACTERS } from "@stll/api-contract/desktop-dictation-cleanup";
import {
  DESKTOP_DICTATION_MODELS_LABELED_QUERY,
  DESKTOP_DICTATION_MODELS_RETENTION_QUERY,
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
  desktopChunkVocabulary,
  listDictationModels,
  matterTerms,
  takesVocabulary,
} from "./desktop-transcription";
import type { DictationDependencies } from "./transcribe";

const testState = createTestState({ file: import.meta.path, config: env });

type DesktopTranscribeReadMatter = NonNullable<
  Parameters<typeof createDesktopDictationTranscribeEndpoint>[0]
>["readMatter"];

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

const OPENROUTER_ONLY = { openRouter: true, elevenLabs: null } as const;
const listModels = (
  settings: Parameters<typeof listDictationModels>[0],
  options: Parameters<typeof listDictationModels>[1] = {},
) => listDictationModels(settings, { deployment: OPENROUTER_ONLY, ...options });

test("only the models offered in the organization's region are listed", () => {
  const listed = listModels({
    orgAIConfig: null,
    managedAIResidency: "eu",
  });
  const offered = Object.keys(TRANSCRIPTION_MODELS)
    .filter(isTranscriptionModelId)
    .filter(
      (modelId) =>
        TRANSCRIPTION_MODELS[modelId].route === "openrouter" &&
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

test("a labeling desktop also gets the models outside its region, after the regional ones and marked", () => {
  const settings = { orgAIConfig: null, managedAIResidency: "eu" } as const;
  const regional = listModels(settings);
  const labeled = listModels(settings, { labeled: true });
  const outside = Object.keys(TRANSCRIPTION_MODELS)
    .filter(isTranscriptionModelId)
    .filter(
      (modelId) =>
        TRANSCRIPTION_MODELS[modelId].residency.eu.status !== "available" &&
        TRANSCRIPTION_MODELS[modelId].residency.global.status === "available",
    );
  expect(outside).toContain("google/chirp-3");
  expect(labeled.models.map(({ id }) => id)).toEqual([
    ...regional.models.map(({ id }) => id),
    ...outside,
  ]);
  for (const model of labeled.models) {
    if (!isTranscriptionModelId(model.id)) {
      throw new TypeError("Expected catalog model id");
    }
    expect(model).toEqual({
      id: model.id,
      displayName: TRANSCRIPTION_MODELS[model.id].displayName,
      provider: TRANSCRIPTION_MODELS[model.id].provider,
      outsideRegion: outside.some((id) => id === model.id),
      takesVocabulary: takesVocabulary(model.id),
    });
  }
  // The default never leaves the region.
  expect(labeled.defaultModelId).toBe(regional.defaultModelId);
  // An older desktop refuses fields it does not know.
  for (const model of regional.models) {
    expect(Object.keys(model).toSorted()).toEqual(["displayName", "id"]);
  }
  expect(v.parse(desktopDictationModelsSchema, labeled)).toEqual(labeled);
});

test("the deployment's ElevenLabs key offers Scribe v3 in its environment's region, and elsewhere only labeled as outside it", () => {
  const direct = "elevenlabs-direct/scribe-v3";
  const withKey = (environment: "default" | "us" | "eu") => ({
    openRouter: true,
    elevenLabs: {
      apiKey: "elevenlabs-fixture",
      environment,
      zeroRetention: true,
    },
  });
  const ids = (listed: { models: readonly { id: string }[] }) =>
    listed.models.map(({ id }) => id);
  const eu = { orgAIConfig: null, managedAIResidency: "eu" } as const;
  const us = { orgAIConfig: null, managedAIResidency: "us" } as const;
  expect(ids(listModels(eu, { deployment: withKey("eu") }))).toContain(direct);
  expect(ids(listModels(us, { deployment: withKey("default") }))).toContain(
    direct,
  );
  expect(ids(listModels(eu, { deployment: withKey("us") }))).not.toContain(
    direct,
  );
  expect(
    listModels(eu, { deployment: withKey("us"), labeled: true }).models,
  ).toContainEqual({
    id: direct,
    displayName: "Scribe v3",
    provider: "ElevenLabs",
    outsideRegion: true,
    takesVocabulary: false,
  });
  // An organization on its own AI provider still gets the direct model, on
  // stella's key as stella usage.
  for (const orgAIConfig of [OWN_OPENROUTER, OWN_OTHER_PROVIDER]) {
    expect(
      ids(
        listModels(
          { orgAIConfig, managedAIResidency: "eu" },
          { deployment: withKey("eu"), labeled: true },
        ),
      ),
    ).toContain(direct);
  }
  // A deployment with only an ElevenLabs key offers it alone, as default.
  expect(
    listModels(eu, {
      deployment: { ...withKey("eu"), openRouter: false },
      labeled: true,
    }),
  ).toEqual({
    models: [
      {
        id: direct,
        displayName: "Scribe v3",
        provider: "ElevenLabs",
        outsideRegion: false,
        takesVocabulary: false,
      },
    ],
    defaultModelId: direct,
    unavailable: null,
  });
  expect(
    listModels(eu, { deployment: { openRouter: false, elevenLabs: null } }),
  ).toEqual({ models: [], defaultModelId: null, unavailable: "provider" });
});

test("a key without zero retention is listed only to a desktop that warns, marked, and never as the default", () => {
  const direct = "elevenlabs-direct/scribe-v3";
  const deployment = {
    openRouter: true,
    elevenLabs: {
      apiKey: "elevenlabs-fixture",
      environment: "eu",
      zeroRetention: false,
    },
  } as const;
  const eu = { orgAIConfig: null, managedAIResidency: "eu" } as const;
  const ids = (listed: { models: readonly { id: string }[] }) =>
    listed.models.map(({ id }) => id);
  expect(ids(listModels(eu, { deployment }))).not.toContain(direct);
  expect(ids(listModels(eu, { deployment, labeled: true }))).not.toContain(
    direct,
  );
  // A desktop that warns, for a member not granted such models: unlisted.
  expect(
    ids(listModels(eu, { deployment, labeled: true, retention: true })),
  ).not.toContain(direct);
  const warned = listModels(eu, {
    deployment,
    labeled: true,
    retention: true,
    retainingModels: true,
  });
  expect(warned.models).toContainEqual({
    id: direct,
    displayName: "Scribe v3",
    provider: "ElevenLabs",
    outsideRegion: false,
    retainsData: true,
    takesVocabulary: false,
  });
  expect(warned.defaultModelId).not.toBe(direct);
  for (const model of warned.models) {
    expect(model).toHaveProperty("retainsData", model.id === direct);
  }
  // Only the key without zero retention: listed with its warning, no default.
  expect(
    listModels(eu, {
      deployment: { ...deployment, openRouter: false },
      labeled: true,
      retention: true,
      retainingModels: true,
    }),
  ).toMatchObject({ defaultModelId: null, unavailable: null });
});

test("a region without a model lists nothing, with the reason, and an own AI provider still lists stella's models", () => {
  // Read as a plain status: the catalog may offer no model in the region.
  const offeredIn = (status: string) => status === "available";
  const usOffers = Object.values(TRANSCRIPTION_MODELS).some(({ residency }) =>
    offeredIn(residency.us.status),
  );
  expect(listModels({ orgAIConfig: null, managedAIResidency: "us" })).toEqual(
    usOffers
      ? expect.objectContaining({ unavailable: null })
      : { models: [], defaultModelId: null, unavailable: "region" },
  );
  expect(listModels({ orgAIConfig: null, managedAIResidency: null })).toEqual({
    models: [],
    defaultModelId: null,
    unavailable: "region",
  });
  // Another AI provider of the organization's own transcribes with stella.
  expect(
    listModels({
      orgAIConfig: OWN_OTHER_PROVIDER,
      managedAIResidency: "eu",
    }).unavailable,
  ).toBeNull();
  expect(
    listModels({
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
    createDesktopDictationModelsEndpoint({
      authorizeAccount,
      loadSettings,
      readDeployment: () => OPENROUTER_ONLY,
    }),
  );
  const response = await server.fetch(new Request("http://localhost/models"));
  expect(response.status).toBe(200);
  expect(v.parse(desktopDictationModelsSchema, await response.json())).toEqual(
    listModels({ orgAIConfig: null, managedAIResidency: "eu" }),
  );
});

test("a desktop that asks for labels reads the labeled list", async () => {
  const server = serveModels(
    createDesktopDictationModelsEndpoint({
      authorizeAccount,
      loadSettings,
      readDeployment: () => OPENROUTER_ONLY,
    }),
  );
  const response = await server.fetch(
    new Request(
      `http://localhost/models?${DESKTOP_DICTATION_MODELS_LABELED_QUERY}=1`,
    ),
  );
  expect(response.status).toBe(200);
  expect(v.parse(desktopDictationModelsSchema, await response.json())).toEqual(
    listModels(
      { orgAIConfig: null, managedAIResidency: "eu" },
      { labeled: true },
    ),
  );
});

test("a model whose provider keeps the audio is listed only to a member granted such models", async () => {
  const deployment = {
    openRouter: true,
    elevenLabs: {
      apiKey: "elevenlabs-fixture",
      environment: "eu",
      zeroRetention: false,
    },
  } as const;
  const server = serveModels(
    createDesktopDictationModelsEndpoint({
      authorizeAccount,
      loadSettings,
      readDeployment: () => deployment,
    }),
  );
  const listed = async () => {
    const response = await server.fetch(
      new Request(
        `http://localhost/models?${DESKTOP_DICTATION_MODELS_LABELED_QUERY}=1&${DESKTOP_DICTATION_MODELS_RETENTION_QUERY}=1`,
      ),
    );
    expect(response.status).toBe(200);
    return v
      .parse(desktopDictationModelsSchema, await response.json())
      .models.map(({ id }) => id);
  };
  expect(await listed()).not.toContain("elevenlabs-direct/scribe-v3");
  testState.setConfig("API_FEATURE_ACCESS_GRANTS", {
    "desktop-dictation": [GRANT],
    "desktop-dictation-cloud": [GRANT],
    "desktop-dictation-retaining-models": [GRANT],
  });
  expect(await listed()).toContain("elevenlabs-direct/scribe-v3");
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
  deployment = OPENROUTER_ONLY,
  modelId,
  matterId,
  readMatter,
  pieceId,
  vocabulary,
  audioMs = 1234,
}: {
  withhold?: () => void;
  email?: string | null;
  text?: string;
  deployment?: ReturnType<DictationDependencies["deployment"]>;
  modelId?: string;
  matterId?: string;
  readMatter?: DesktopTranscribeReadMatter;
  pieceId?: string;
  vocabulary?: string;
  audioMs?: number;
} = {}) => {
  withhold();
  const settle = mock(
    async (_options: Parameters<DictationDependencies["settle"]>[0]) =>
      await Promise.resolve(Result.ok(undefined)),
  );
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
    ...(readMatter === undefined ? {} : { readMatter }),
    dependencies: asTestRaw<Partial<DictationDependencies>>({
      transcribe,
      transcribeElevenLabs: transcribe,
      deployment: () => deployment,
      credential: async () => await Promise.resolve(Result.ok({ apiKey: "k" })),
      limit: async () => await Promise.resolve(Result.ok(undefined)),
      preflight: async () => await Promise.resolve(Result.ok(undefined)),
      settle,
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
    new File([makeWavAudioBytes(audioMs)], "dictation.wav", {
      type: "audio/wav",
    }),
  );
  if (pieceId !== undefined) {
    form.set("pieceId", pieceId);
  }
  form.set("language", "cs");
  if (modelId !== undefined) {
    form.set("modelId", modelId);
  }
  if (matterId !== undefined) {
    form.set("matterId", matterId);
  }
  if (vocabulary !== undefined) {
    form.set("vocabulary", vocabulary);
  }
  const response = await server.fetch(
    new Request("http://localhost/transcribe", { method: "POST", body: form }),
  );
  return { response, transcribe, settle };
};

test("a model whose provider keeps the audio transcribes only for a member granted such models", async () => {
  const scribe = {
    modelId: "elevenlabs-direct/scribe-v3",
    deployment: {
      openRouter: true,
      elevenLabs: {
        apiKey: "elevenlabs-fixture",
        environment: "eu",
        zeroRetention: false,
      },
    },
  } as const;
  const refused = await exerciseTranscribe(scribe);
  expect(refused.response.status).toBe(503);
  expect(refused.transcribe).not.toHaveBeenCalled();

  const granted = await exerciseTranscribe({
    ...scribe,
    withhold: () => {
      testState.setConfig("API_FEATURE_ACCESS_GRANTS", {
        "desktop-dictation": [GRANT],
        "desktop-dictation-cloud": [GRANT],
        "desktop-dictation-retaining-models": [GRANT],
      });
    },
  });
  expect(granted.response.status).toBe(200);
  expect(granted.transcribe.mock.calls.at(0)?.[0]).toMatchObject({
    modelId: scribe.modelId,
  });
});

test("a granted desktop's audio is transcribed with the region's default model and its language", async () => {
  const { response, transcribe } = await exerciseTranscribe();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ text: "Dobrý den." });
  expect(transcribe.mock.calls.at(0)?.[0]).toMatchObject({
    modelId: defaultTranscriptionModelId("eu"),
    language: "cs",
  });
});

test("a recording's piece sent again is counted under the key of its first attempt", async () => {
  const pieceId = "0198c5e2-7c1f-4a6e-9a3b-2f4d5e6f7a8b";
  const usageKeyOf = async (options: {
    pieceId?: string;
    audioMs?: number;
  }) => {
    const { response, settle } = await exerciseTranscribe(options);
    expect(response.status).toBe(200);
    return settle.mock.calls.at(0)?.[0].usageKey;
  };
  const first = await usageKeyOf({ pieceId });
  const again = await usageKeyOf({ pieceId });
  expect(first?.resourceId).toBe(pieceId);
  expect(again).toEqual(first);
  // The same id with other audio is another piece, counted on its own.
  const other = await usageKeyOf({ pieceId, audioMs: 2345 });
  expect(other?.idempotencyKey).not.toBe(first?.idempotencyKey);
  // Dictation's own chunks name no piece; each request is its own event.
  expect(await usageKeyOf({})).toBeUndefined();
});

test("a piece id that is not a UUID is refused before any audio is sent", async () => {
  const { response, transcribe } = await exerciseTranscribe({
    pieceId: "piece-1",
  });
  expect(response.status).toBe(422);
  expect(transcribe).not.toHaveBeenCalled();
});

test("a transcript is answered without a character the desktop would not type", async () => {
  const text = "ls\r\n-la\u2028pwd\u2029\u202Eok\u2066\u0007";
  expect(DESKTOP_DICTATION_UNTYPED_CHARACTERS.test(text)).toBe(true);
  const { response } = await exerciseTranscribe({ text });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ text: "ls -la pwd ok " });
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

const MATTER_ID = "0198c5e2-7c1f-7a6e-9a3b-2f4d5e6f7a8b";
const VOCABULARY_MODEL = "openai/whisper-large-v3";

const matterReader = (visible: boolean) =>
  mock(
    async (_account: unknown, matterId: string) =>
      await Promise.resolve({
        workspace: visible
          ? { id: toSafeId<"workspace">(matterId), status: "active" as const }
          : null,
        vocabulary: ["Novák v Stavby Praha", "22 Cdo 120/2026", "Libeňská"],
      }),
  );

test("a piece of a recording filed under a matter gives a model that reads vocabulary the matter's names", async () => {
  expect(TRANSCRIPTION_MODELS[VOCABULARY_MODEL].vocabularyMechanism).toBe(
    "groq-prompt",
  );
  const readMatter = matterReader(true);
  const { response, transcribe } = await exerciseTranscribe({
    modelId: VOCABULARY_MODEL,
    matterId: MATTER_ID,
    readMatter: asTestRaw<DesktopTranscribeReadMatter>(readMatter),
  });
  expect(response.status).toBe(200);
  expect(readMatter.mock.calls.at(0)?.[1]).toBe(MATTER_ID);
  expect(transcribe.mock.calls.at(0)?.[0]).toMatchObject({
    modelId: VOCABULARY_MODEL,
    vocabulary: ["Novák v Stavby Praha", "22 Cdo 120/2026", "Libeňská"],
  });
});

test("a model that takes no vocabulary gets none, and a piece without a matter reads none", async () => {
  const readMatter = matterReader(true);
  const regional = await exerciseTranscribe({
    matterId: MATTER_ID,
    readMatter: asTestRaw<DesktopTranscribeReadMatter>(readMatter),
  });
  expect(regional.response.status).toBe(200);
  expect(regional.transcribe.mock.calls.at(0)?.[0].vocabulary).toBeUndefined();
  const unfiled = matterReader(true);
  const plain = await exerciseTranscribe({
    modelId: VOCABULARY_MODEL,
    readMatter: asTestRaw<DesktopTranscribeReadMatter>(unfiled),
  });
  expect(plain.response.status).toBe(200);
  expect(unfiled).not.toHaveBeenCalled();
  expect(plain.transcribe.mock.calls.at(0)?.[0].vocabulary).toBeUndefined();
});

test("a matter the member cannot see is not found and nothing is transcribed", async () => {
  const { response, transcribe } = await exerciseTranscribe({
    modelId: VOCABULARY_MODEL,
    matterId: MATTER_ID,
    readMatter: asTestRaw<DesktopTranscribeReadMatter>(matterReader(false)),
  });
  expect(response.status).toBe(404);
  expect(transcribe).not.toHaveBeenCalled();
});

test("a matter's vocabulary is each term once, short enough for a hint, and bounded", () => {
  expect(
    matterTerms([
      { term: " Novák " },
      { term: "Novák" },
      { term: "" },
      { term: "x".repeat(101) },
      { term: "Stavby Praha" },
    ]),
  ).toEqual(["Novák", "Stavby Praha"]);
  expect(
    matterTerms(
      Array.from({ length: 150 }, (_unused, index) => ({ term: `t${index}` })),
    ),
  ).toHaveLength(100);
});

test("a labeling desktop learns which models read vocabulary", () => {
  const listed = listModels(
    { orgAIConfig: null, managedAIResidency: "eu" },
    { labeled: true },
  );
  expect(listed.models.some((model) => model.takesVocabulary === true)).toBe(
    true,
  );
  for (const model of listed.models) {
    expect(model.takesVocabulary).toBe(takesVocabulary(model.id));
  }
  expect(takesVocabulary(VOCABULARY_MODEL)).toBe(true);
  expect(takesVocabulary("elevenlabs-direct/scribe-v3")).toBe(false);
  expect(takesVocabulary(undefined)).toBe(false);
});

test("the speaker's custom words reach a model that reads vocabulary, before the matter's names", async () => {
  const readMatter = matterReader(true);
  const { response, transcribe } = await exerciseTranscribe({
    modelId: VOCABULARY_MODEL,
    matterId: MATTER_ID,
    readMatter: asTestRaw<DesktopTranscribeReadMatter>(readMatter),
    vocabulary: JSON.stringify(["custom terms list", "libeňská"]),
  });
  expect(response.status).toBe(200);
  expect(transcribe.mock.calls.at(0)?.[0].vocabulary).toEqual([
    "custom terms list",
    "libeňská",
    "Novák v Stavby Praha",
    "22 Cdo 120/2026",
  ]);
  const unfiled = await exerciseTranscribe({
    modelId: VOCABULARY_MODEL,
    vocabulary: JSON.stringify(["custom terms list"]),
  });
  expect(unfiled.response.status).toBe(200);
  expect(unfiled.transcribe.mock.calls.at(0)?.[0].vocabulary).toEqual([
    "custom terms list",
  ]);
});

test("custom words sent with a model that reads no vocabulary are dropped, never a refusal", async () => {
  const { response, transcribe } = await exerciseTranscribe({
    vocabulary: JSON.stringify(["custom terms list"]),
  });
  expect(response.status).toBe(200);
  expect(transcribe.mock.calls.at(0)?.[0].vocabulary).toBeUndefined();
});

test("custom words beyond the contract's limits are refused before any audio is sent", async () => {
  for (const vocabulary of [
    JSON.stringify(
      Array.from({ length: 101 }, (_unused, index) => `w${index}`),
    ),
    JSON.stringify(["x".repeat(101)]),
    JSON.stringify([""]),
    "not json",
  ]) {
    const { response, transcribe } = await exerciseTranscribe({
      modelId: VOCABULARY_MODEL,
      vocabulary,
    });
    expect(response.status).toBe(422);
    expect(transcribe).not.toHaveBeenCalled();
  }
});

test("a chunk's vocabulary keeps each term once whatever its case, own words first, bounded", () => {
  expect(
    desktopChunkVocabulary(["Libeňská", " NDA "], ["libeňská", "Novák", "nda"]),
  ).toEqual(["Libeňská", "NDA", "Novák"]);
  expect(desktopChunkVocabulary(undefined, ["Novák"])).toEqual(["Novák"]);
  expect(
    desktopChunkVocabulary(
      Array.from({ length: 80 }, (_unused, index) => `own${index}`),
      Array.from({ length: 80 }, (_unused, index) => `matter${index}`),
    ),
  ).toHaveLength(100);
});
