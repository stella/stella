import { afterAll, beforeEach, expect, test } from "bun:test";
import * as v from "valibot";

import {
  DESKTOP_DICTATION_CLEANUP_LIMITS,
  desktopDictationCleanupResponseSchema,
} from "@stll/api-contract/desktop-dictation-cleanup";
import { createTestState } from "@stll/test-state";

import { env } from "@/api/env";
import { HttpStatusResponse } from "@/api/http/status";
import {
  DICTATING_ORGANIZATION_ID as ORGANIZATION_ID,
  DICTATING_USER_ID as USER_ID,
  exerciseDesktopDictationEndpoint,
  exerciseMemberDictationEndpoint,
  grantDesktopDictation,
  testDesktopDictationGate,
  testMemberDictationGate,
} from "@/api/tests/helpers/desktop-dictation-endpoint";
import type { TestServer } from "@/api/tests/helpers/test-server";

import { createDictationCleanupEndpoint } from "./cleanup";
import {
  DICTATION_CLEANUP_SYSTEM_PROMPT,
  type DictationCleanupModelOutput,
  dictationCleanupModelOutputSchema,
} from "./cleanup-model";
import { createMemberDictationCleanupEndpoint } from "./member-cleanup";

const testState = createTestState({ file: import.meta.path, config: env });

const servers: TestServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map(async (server) => await server.stop()));
});

const TRANSCRIPT = "a tedy nový řádek se rozhodl odejít za tučně 24 dní";

beforeEach(() => {
  grantDesktopDictation(testState);
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

type ExerciseOptions = {
  input?: unknown;
  granted?: boolean;
  role?: "member" | "external";
  limited?: boolean;
  answer?: () => DictationCleanupModelOutput;
};

const exercise = async ({
  input = { transcript: TRANSCRIPT, locale: "cs", languages: ["cs", "en"] },
  answer = () => CLEANED,
  ...options
}: ExerciseOptions = {}) =>
  await exerciseDesktopDictationEndpoint({
    createEndpoint: createDictationCleanupEndpoint,
    testState,
    servers,
    input,
    answer,
    ...options,
  });

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

testDesktopDictationGate({
  exercise,
  transcript: TRANSCRIPT,
  invalidInputs: [
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
    [
      "a locale that is not a language tag",
      { transcript: "ok", locale: "a b" },
    ],
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
  ],
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

/** The member route: a signed-in member's session, no desktop decision. */
const exerciseMember = async (
  options: { role?: "member" | "external"; limited?: boolean } = {},
) =>
  await exerciseMemberDictationEndpoint({
    createEndpoint: createMemberDictationCleanupEndpoint,
    testState,
    route: "/v1/dictation/cleanup",
    body: { transcript: TRANSCRIPT, locale: "cs", languages: ["cs", "en"] },
    answer: () => CLEANED,
    ...options,
  });

test("a signed-in member gets the same cleanup as a desktop, without any desktop decision", async () => {
  const { result, calls, limit } = await exerciseMember();
  if (result instanceof HttpStatusResponse) {
    throw new TypeError(
      `Expected the cleaned segments, got ${String(result.code)}`,
    );
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

testMemberDictationGate(exerciseMember);
