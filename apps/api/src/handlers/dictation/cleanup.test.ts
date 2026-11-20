import { Result } from "better-result";
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import * as v from "valibot";

import {
  DESKTOP_DICTATION_CLEANUP_LIMITS,
  desktopDictationCleanupResponseSchema,
} from "@stll/api-contract/desktop-dictation-cleanup";
import { createTestState } from "@stll/test-state";

import { safeDbFromScoped } from "@/api/db/safe-db";
import { env } from "@/api/env";
import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import { HttpStatusResponse } from "@/api/http/status";
import type { loadOrgAISettings } from "@/api/lib/ai-config-loader";
import { toSafeId } from "@/api/lib/branded-types";
import {
  CLEANUP_ORGANIZATION_TERMS,
  mergeDictationTerms,
} from "@/api/lib/dictation/organization-vocabulary";
import type { readCleanupVocabulary } from "@/api/lib/dictation/organization-vocabulary";
import {
  buildVocabularyIndex,
  selectVocabulary,
} from "@/api/lib/dictation/vocabulary-index";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { buildFeatureAccessSnapshot } from "@/api/lib/feature-access/snapshot";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import type { withActionAdmission } from "@/api/lib/rate-limit/action-admission";
import type { generateTanStackObjectForTask } from "@/api/lib/tanstack-ai-generate";
import {
  claimFixtureDeviceProof,
  createDesktopDeviceSigner,
} from "@/api/tests/helpers/desktop-device-proof";
import { runDispatchCheck } from "@/api/tests/helpers/dispatch-check";
import {
  createTestHandlerContext,
  NO_AUDIT,
} from "@/api/tests/helpers/handler-context";
import { serveForTest, type TestServer } from "@/api/tests/helpers/test-server";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { createDictationCleanupEndpoint } from "./cleanup";
import {
  DICTATION_CLEANUP_SYSTEM_PROMPT,
  type DictationCleanupModelOutput,
  dictationCleanupModelOutputSchema,
} from "./cleanup-model";
import type { consumeDictationLimit } from "./limits";
import { createMemberDictationCleanupEndpoint } from "./member-cleanup";

const testState = createTestState({ file: import.meta.path, config: env });

const servers: TestServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map(async (server) => await server.stop()));
});

const USER_ID = toSafeId<"user">("dictating-member");
const ORGANIZATION_ID = toSafeId<"organization">("dictating-firm");
const EMAIL = "dictation@example.test";
const TRANSCRIPT = "a tedy nový řádek se rozhodl odejít za tučně 24 dní";

beforeEach(() => {
  testState.setConfig("API_FEATURE_ACCESS_GRANTS", {
    "desktop-dictation": [
      { type: "member", organizationId: ORGANIZATION_ID, email: EMAIL },
    ],
  });
});

const CLEANED: DictationCleanupModelOutput = {
  segments: [
    { type: "text", text: "a tedy", bold: false },
    { type: "lineBreak", text: "", bold: false },
    { type: "text", text: "se rozhodl odejít za ", bold: false },
    { type: "text", text: "24", bold: true },
    { type: "text", text: " dní.", bold: false },
  ],
};

/** The organization's words as the real selection picks them, without a
 *  database. */
const organizationWords =
  (newestFirst: readonly string[]): typeof readCleanupVocabulary =>
  async ({ transcript, personal = [] }) =>
    await Promise.resolve(
      Result.ok(
        mergeDictationTerms(
          [
            personal,
            selectVocabulary(
              buildVocabularyIndex(newestFirst),
              transcript,
              CLEANUP_ORGANIZATION_TERMS,
            ),
          ],
          personal.length + CLEANUP_ORGANIZATION_TERMS,
        ),
      ),
    );

type ExerciseOptions = {
  input?: unknown;
  organization?: readonly string[];
  granted?: boolean;
  role?: "member" | "external";
  limited?: boolean;
  answer?: () => DictationCleanupModelOutput;
};

const exercise = async ({
  input = { transcript: TRANSCRIPT, locale: "cs", languages: ["cs", "en"] },
  granted = true,
  role = "member",
  limited = false,
  answer = () => CLEANED,
  organization = [],
}: ExerciseOptions = {}) => {
  if (!granted) {
    testState.setConfig("API_FEATURE_ACCESS_GRANTS", {});
  }
  const calls: { system: string; prompt: string; schema: unknown }[] = [];
  const { scopedDb } = createScopedDbMock({});
  const generate = mock(
    async (options: Parameters<typeof generateTanStackObjectForTask>[0]) => {
      await runDispatchCheck(options.beforeEachDispatch);
      calls.push({
        system: options.system ?? "",
        prompt: options.prompt ?? "",
        schema: options.outputSchema,
      });
      return await Promise.resolve(answer());
    },
  );
  const limit = mock(
    async (_options: Parameters<typeof consumeDictationLimit>[0]) =>
      await Promise.resolve(
        limited
          ? Result.err(
              new HandlerError({
                status: 429,
                code: "rate_limited",
                message: "Too many dictation cleanup requests",
              }),
            )
          : Result.ok(undefined),
      ),
  );
  const endpoint = createDictationCleanupEndpoint({
    authorizeAccount: async (request) => {
      const device = await createDesktopDeviceSigner();
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
            credential: "dictation-cleanup-fixture",
          }),
          deviceJkt: device.deviceJkt,
          keyId: "linked-desktop",
          credential: "dictation-cleanup-fixture",
        }),
        organizationId: ORGANIZATION_ID,
        userId: USER_ID,
        keyId: "linked-desktop",
        memberRole: sessionMemberRole(role),
        scopedDb,
      });
    },
    loadAISettings: asTestRaw<typeof loadOrgAISettings>(
      async () =>
        await Promise.resolve(
          Result.ok({
            orgAIConfig: null,
            promptCachingEnabled: false,
            managedAIResidency: "eu",
          }),
        ),
    ),
    limit: asTestRaw<typeof consumeDictationLimit>(limit),
    generateObjectForTask:
      asTestRaw<typeof generateTanStackObjectForTask>(generate),
    readVocabulary: organizationWords(organization),
    admit: asTestRaw<typeof withActionAdmission>(
      async ({ run }: Parameters<typeof withActionAdmission>[0]) =>
        Result.ok(
          await run(new AbortController().signal, {
            reservePeriod: async () => Result.ok(undefined),
          }),
        ),
    ),
  });
  const server = serveForTest(
    createHttpApp({
      middleware: [errorBoundary],
      routes: routes({ "/cleanup": { POST: endpoint } }),
    }),
  );
  servers.push(server);
  const response = await server.fetch(
    new Request("http://localhost/cleanup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  return { response, calls, generate, limit };
};

test("a granted desktop gets the model's segments for its transcript text", async () => {
  const { response, calls, limit } = await exercise();
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  expect(v.parse(desktopDictationCleanupResponseSchema, body)).toEqual({
    segments: [
      { type: "text", text: "a tedy", bold: false },
      { type: "lineBreak" },
      { type: "text", text: "se rozhodl odejít za ", bold: false },
      { type: "text", text: "24", bold: true },
      { type: "text", text: " dní.", bold: false },
    ],
  });
  expect(calls).toHaveLength(1);
  expect(calls.at(0)?.schema).toBe(dictationCleanupModelOutputSchema);
  expect(calls.at(0)?.system).toBe(DICTATION_CLEANUP_SYSTEM_PROMPT);
  // The transcript reaches the model as a JSON value, never as instructions.
  expect(JSON.parse(calls.at(0)?.prompt ?? "null")).toEqual({
    languages: ["cs", "en"],
    locale: "cs",
    transcript: TRANSCRIPT,
  });
  expect(limit.mock.calls.at(0)?.[0]).toMatchObject({ operation: "cleanup" });
});

test("the organization's words the transcript mentions follow the speaker's own", async () => {
  const { response, calls } = await exercise({
    input: {
      transcript: "pošli to do Majkrosoftu a Novakovi",
      vocabulary: ["Novák"],
    },
    organization: ["Deloitte", "Microsoft", "novák"],
  });
  expect(response.status).toBe(200);
  expect(JSON.parse(calls.at(0)?.prompt ?? "null")).toMatchObject({
    vocabulary: ["Novák", "Microsoft"],
  });
});

test("an account without the dictation decision is refused before any model call", async () => {
  const { response, generate, limit } = await exercise({ granted: false });
  expect(response.status).toBe(403);
  expect(generate).not.toHaveBeenCalled();
  expect(limit).not.toHaveBeenCalled();
});

test("a role that may not use AI is refused before any model call", async () => {
  const { response, generate } = await exercise({ role: "external" });
  expect(response.status).toBe(403);
  expect(generate).not.toHaveBeenCalled();
});

test("an exhausted cleanup budget refuses before any model call", async () => {
  const { response, generate } = await exercise({ limited: true });
  expect(response.status).toBe(429);
  expect(generate).not.toHaveBeenCalled();
});

test.each([
  [
    "a transcript over the limit",
    {
      transcript: "x".repeat(
        DESKTOP_DICTATION_CLEANUP_LIMITS.transcriptLength + 1,
      ),
    },
  ],
  ["an empty transcript", { transcript: "" }],
  ["audio instead of text", { transcript: "ok", audio: "UklGRg==" }],
  ["a locale that is not a language tag", { transcript: "ok", locale: "a b" }],
  [
    "a window title over the limit",
    {
      transcript: "ok",
      context: {
        appKind: "document",
        windowTitle: "x".repeat(
          DESKTOP_DICTATION_CLEANUP_LIMITS.windowTitleLength + 1,
        ),
      },
    },
  ],
  [
    "text before the cursor over the limit",
    {
      transcript: "ok",
      context: {
        appKind: "document",
        textBeforeCursor: "x".repeat(
          DESKTOP_DICTATION_CLEANUP_LIMITS.textBeforeCursorLength + 1,
        ),
      },
    },
  ],
  ["an unknown app kind", { transcript: "ok", context: { appKind: "word" } }],
])("%s is refused before any model call", async (_case, input) => {
  const { response, generate } = await exercise({ input });
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(response.status).toBeLessThan(500);
  expect(generate).not.toHaveBeenCalled();
});

test("a failed model call answers a bounded error without the transcript", async () => {
  const { response } = await exercise({
    answer: () => {
      throw new TypeError(`provider echoed ${TRANSCRIPT}`);
    },
  });
  expect(response.status).toBeGreaterThanOrEqual(500);
  expect(await response.text()).not.toContain("rozhodl");
});

test("an answer that adds content is refused rather than typed", async () => {
  const { response } = await exercise({
    input: { transcript: "what is the limitation period" },
    answer: () => ({
      segments: [
        {
          type: "text",
          text: "What is the limitation period? It is three years from the day the claimant learned of the damage.",
          bold: false,
        },
      ],
    }),
  });
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain("three years");
});

test("an answer that lost most of the dictation is refused rather than typed", async () => {
  const { response } = await exercise({
    input: {
      transcript: "the parties agree to extend the deadline by two weeks",
    },
    answer: () => ({
      segments: [{ type: "text", text: "The parties agree.", bold: false }],
    }),
  });
  expect(response.status).toBe(502);
});

test("a line break or carriage return inside text never reaches the desktop", async () => {
  const { response } = await exercise({
    input: { transcript: "first second" },
    answer: () => ({
      segments: [{ type: "text", text: "first\r\nsecond", bold: false }],
    }),
  });
  expect(response.status).toBe(200);
  // One line ending, however many characters spell it, is one space.
  expect(await response.json()).toEqual({
    segments: [{ type: "text", text: "first second", bold: false }],
  });
});

test("where the text goes reaches the model as its own field, and the answer is checked against the transcript", async () => {
  const context = {
    appKind: "document",
    windowTitle: "Kupní smlouva – Novák.docx",
    textBeforeCursor: "Článek 2\nKupní cena\n",
  } as const;
  const { response, calls } = await exercise({
    input: { transcript: TRANSCRIPT, locale: "cs", context },
  });
  expect(response.status).toBe(200);
  expect(JSON.parse(calls.at(0)?.prompt ?? "null")).toEqual({
    languages: [],
    locale: "cs",
    context,
    transcript: TRANSCRIPT,
  });
  // An answer that repeats the text before the cursor outgrows the
  // transcript it is measured against.
  const echoed = await exercise({
    input: { transcript: "first second", context },
    answer: () => ({
      segments: [
        {
          type: "text",
          text: `${context.textBeforeCursor} first second`,
          bold: false,
        },
      ],
    }),
  });
  expect(echoed.response.status).toBe(502);
  expect(await echoed.response.text()).not.toContain("Kupní cena");
});

const admitInline = asTestRaw<typeof withActionAdmission>(
  async ({ run }: Parameters<typeof withActionAdmission>[0]) =>
    Result.ok(
      await run(new AbortController().signal, {
        reservePeriod: async () => Result.ok(undefined),
      }),
    ),
);

/** The member route: a signed-in member's session, no desktop decision. */
const exerciseMember = async ({
  role = "member",
  limited = false,
}: { role?: "member" | "external"; limited?: boolean } = {}) => {
  testState.setConfig("API_FEATURE_ACCESS_GRANTS", {});
  const calls: { system: string; prompt: string }[] = [];
  const { scopedDb } = createScopedDbMock({});
  const generate = mock(
    async (options: Parameters<typeof generateTanStackObjectForTask>[0]) => {
      await runDispatchCheck(options.beforeEachDispatch);
      calls.push({
        system: options.system ?? "",
        prompt: options.prompt ?? "",
      });
      return await Promise.resolve(CLEANED);
    },
  );
  const limit = mock(
    async (_options: Parameters<typeof consumeDictationLimit>[0]) =>
      await Promise.resolve(
        limited
          ? Result.err(
              new HandlerError({
                status: 429,
                code: "rate_limited",
                message: "Too many dictation cleanup requests",
              }),
            )
          : Result.ok(undefined),
      ),
  );
  const endpoint = createMemberDictationCleanupEndpoint({
    admit: admitInline,
    limit: asTestRaw<typeof consumeDictationLimit>(limit),
    generateObjectForTask:
      asTestRaw<typeof generateTanStackObjectForTask>(generate),
    readVocabulary: organizationWords([]),
  });
  const result = await endpoint.handler(
    createTestHandlerContext<Parameters<typeof endpoint.handler>[0]>({
      audit: NO_AUDIT,
      scopedDb,
      safeDb: safeDbFromScoped(scopedDb),
      memberRole: sessionMemberRole(role),
      session: { activeOrganizationId: ORGANIZATION_ID },
      user: { id: USER_ID, email: EMAIL },
      body: { transcript: TRANSCRIPT, locale: "cs", languages: ["cs", "en"] },
      request: new Request("https://stella.test/v1/dictation/cleanup", {
        method: "POST",
      }),
      route: "/v1/dictation/cleanup",
    }),
  );
  return { result, calls, generate, limit };
};

test("a signed-in member gets the same cleanup as a desktop, without any desktop decision", async () => {
  const { result, calls, limit } = await exerciseMember();
  if (result instanceof HttpStatusResponse) {
    throw new TypeError(`Expected the cleaned segments, got ${result.code}`);
  }
  expect(v.parse(desktopDictationCleanupResponseSchema, result)).toEqual({
    segments: [
      { type: "text", text: "a tedy", bold: false },
      { type: "lineBreak" },
      { type: "text", text: "se rozhodl odejít za ", bold: false },
      { type: "text", text: "24", bold: true },
      { type: "text", text: " dní.", bold: false },
    ],
  });
  expect(calls).toHaveLength(1);
  expect(calls.at(0)?.system).toBe(DICTATION_CLEANUP_SYSTEM_PROMPT);
  expect(JSON.parse(calls.at(0)?.prompt ?? "null")).toEqual({
    languages: ["cs", "en"],
    locale: "cs",
    transcript: TRANSCRIPT,
  });
  expect(limit.mock.calls.at(0)?.[0]).toMatchObject({
    organizationId: ORGANIZATION_ID,
    userId: USER_ID,
    operation: "cleanup",
  });
});

test("a member whose role may not use AI is refused before the limit or any model call", async () => {
  const { result, generate, limit } = await exerciseMember({
    role: "external",
  });
  expect(result instanceof HttpStatusResponse && result.code).toBe(403);
  expect(limit).not.toHaveBeenCalled();
  expect(generate).not.toHaveBeenCalled();
});

test("a member over the cleanup budget is refused before any model call", async () => {
  const { result, generate } = await exerciseMember({ limited: true });
  expect(result instanceof HttpStatusResponse && result.code).toBe(429);
  expect(generate).not.toHaveBeenCalled();
});
