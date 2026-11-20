import { Result } from "better-result";
import { expect, mock, test } from "bun:test";

import type { env } from "@/api/env";
import type { consumeDictationLimit } from "@/api/handlers/dictation/limits";
import type {
  DesktopDictationGate,
  DictationGeneration,
} from "@/api/handlers/dictation/model-endpoint";
import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import type { RouteEntry } from "@/api/http/route";
import type { loadOrgAISettings } from "@/api/lib/ai-config-loader";
import { toSafeId } from "@/api/lib/branded-types";
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
import { serveForTest, type TestServer } from "@/api/tests/helpers/test-server";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

/** The member and firm a desktop dictation test runs as. */
export const DICTATING_USER_ID = toSafeId<"user">("dictating-member");
export const DICTATING_ORGANIZATION_ID =
  toSafeId<"organization">("dictating-firm");
export const DICTATING_EMAIL = "dictation@example.test";

/** The part of a file's test state these helpers set. */
type DictationTestState = {
  setConfig: (
    key: "API_FEATURE_ACCESS_GRANTS",
    value: (typeof env)["API_FEATURE_ACCESS_GRANTS"],
  ) => void;
};

/** Grants the desktop dictation feature to the test member. */
export const grantDesktopDictation = (testState: DictationTestState) => {
  testState.setConfig("API_FEATURE_ACCESS_GRANTS", {
    "desktop-dictation": [
      {
        type: "member",
        organizationId: DICTATING_ORGANIZATION_ID,
        email: DICTATING_EMAIL,
      },
    ],
  });
};

export const admitInline = asTestRaw<typeof withActionAdmission>(
  async ({ run }: Parameters<typeof withActionAdmission>[0]) =>
    Result.ok(
      await run(new AbortController().signal, {
        reservePeriod: async () => Result.ok(undefined),
      }),
    ),
);

/** A cleanup budget that is open, or exhausted. */
export const dictationLimit = (limited: boolean) =>
  mock(
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

/** One model call as the endpoint made it. */
export type RecordedModelCall = {
  system: string;
  prompt: string;
  schema: unknown;
  task: string;
  deadlineMs: number | undefined;
  outputTokenBudget: number | undefined;
};

/** A model that records each call and answers with `answer()`. */
export const recordingModel = (answer: () => unknown) => {
  const calls: RecordedModelCall[] = [];
  const generate = mock(
    async (options: Parameters<typeof generateTanStackObjectForTask>[0]) => {
      await runDispatchCheck(options.beforeEachDispatch);
      calls.push({
        system: options.system ?? "",
        prompt: options.prompt ?? "",
        schema: options.outputSchema,
        task: options.task,
        deadlineMs: options.deadlineMs,
        outputTokenBudget: options.outputTokenBudget,
      });
      return await Promise.resolve(answer());
    },
  );
  return { calls, generate };
};

type ExerciseOptions = {
  createEndpoint: (
    options: DictationGeneration & DesktopDictationGate,
  ) => RouteEntry["definition"];
  testState: DictationTestState;
  servers: TestServer[];
  input: unknown;
  granted?: boolean;
  role?: "member" | "external";
  limited?: boolean;
  answer: () => unknown;
};

/**
 * Posts `input` to a desktop dictation endpoint built with a linked desktop
 * account, open settings, an inline admission and a recording model.
 */
export const exerciseDesktopDictationEndpoint = async ({
  createEndpoint,
  testState,
  servers,
  input,
  granted = true,
  role = "member",
  limited = false,
  answer,
}: ExerciseOptions) => {
  if (!granted) {
    testState.setConfig("API_FEATURE_ACCESS_GRANTS", {});
  }
  const { calls, generate } = recordingModel(answer);
  const { scopedDb } = createScopedDbMock({});
  const limit = dictationLimit(limited);
  const endpoint = createEndpoint({
    authorizeAccount: async (request) => {
      const device = await createDesktopDeviceSigner();
      return Result.ok({
        featureAccessSnapshot: buildFeatureAccessSnapshot({
          organizationId: DICTATING_ORGANIZATION_ID,
          userId: DICTATING_USER_ID,
          identity: { email: DICTATING_EMAIL, emailVerified: true },
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
        organizationId: DICTATING_ORGANIZATION_ID,
        userId: DICTATING_USER_ID,
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
    admit: admitInline,
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

type GateExercise = (options: {
  input?: unknown;
  granted?: boolean;
  role?: "member" | "external";
  limited?: boolean;
  answer?: () => never;
}) => Promise<{
  response: Response;
  generate: ReturnType<typeof recordingModel>["generate"];
  limit: ReturnType<typeof dictationLimit>;
}>;

/**
 * The checks every desktop dictation endpoint shares: the feature decision,
 * the member's role and the cleanup budget refuse before any model call, so
 * does a request outside the contract, and a failed model call answers a
 * bounded error that never carries the transcript.
 */
export const testDesktopDictationGate = ({
  exercise,
  transcript,
  invalidInputs,
}: {
  exercise: GateExercise;
  transcript: string;
  invalidInputs: readonly (readonly [string, unknown])[];
}) => {
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

  test.each(invalidInputs)(
    "%s is refused before any model call",
    async (_case, input) => {
      const { response, generate } = await exercise({ input });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      expect(generate).not.toHaveBeenCalled();
    },
  );

  test("a failed model call answers a bounded error without the transcript", async () => {
    const { response } = await exercise({
      answer: () => {
        throw new HandlerError({
          status: 502,
          message: `provider echoed ${transcript}`,
        });
      },
    });
    expect(response.status).toBeGreaterThanOrEqual(500);
    const text = await response.text();
    for (const word of transcript
      .split(" ")
      .filter((part) => part.length > 5)) {
      expect(text).not.toContain(word);
    }
  });
};
