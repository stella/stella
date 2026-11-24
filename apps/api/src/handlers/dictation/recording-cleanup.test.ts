import { afterAll, expect, test } from "bun:test";
import * as v from "valibot";

import {
  DESKTOP_DICTATION_RECORDING_CLEANUP_LIMITS,
  desktopDictationRecordingCleanupResponseSchema,
} from "@stll/api-contract/desktop-dictation-cleanup";

import { HttpStatusResponse } from "@/api/http/status";
import {
  DICTATING_ORGANIZATION_ID,
  DICTATING_USER_ID,
  exerciseDesktopDictationEndpoint,
  exerciseMemberDictationEndpoint,
  testDesktopDictationGate,
  testMemberDictationGate,
} from "@/api/tests/helpers/desktop-dictation-endpoint";
import type { TestServer } from "@/api/tests/helpers/test-server";

import { createMemberRecordingCleanupEndpoint } from "./member-recording-cleanup";
import { createRecordingCleanupEndpoint } from "./recording-cleanup";
import {
  RECORDING_CLEANUP_OUTPUT_TOKENS,
  RECORDING_CLEANUP_SYSTEM_PROMPT,
  type RecordingCleanupModelOutput,
  recordingCleanupModelOutputSchema,
} from "./recording-cleanup-model";

const servers: TestServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map(async (server) => await server.stop()));
});

// Synthetic, never a real recording.
const TRANSCRIPT =
  "Odpovíme v kopii Janě. Eh, ahoj, eh, Petře, odstavec, díky za- eh, rychlou reakci, tečka. Odstavec. Pod to odrážka za prvé tučně čtvrtek, eh, nebo ne, napíšeme to jinak, ten den nemůžu.";
const CLEANED: RecordingCleanupModelOutput = {
  instructions: ["Odpověď v kopii Janě."],
  markdown:
    "Ahoj Petře,\n\ndíky za rychlou reakci.\n\n1. **čtvrtek**: ten den nemůžu.",
};

type ExerciseOptions = {
  input?: unknown;
  emailVerified?: boolean;
  role?: "member" | "external";
  limited?: boolean;
  answer?: () => RecordingCleanupModelOutput;
};

const exercise = async ({
  input = { transcript: TRANSCRIPT, locale: "cs", languages: ["cs"] },
  answer = () => CLEANED,
  ...options
}: ExerciseOptions = {}) =>
  await exerciseDesktopDictationEndpoint({
    createEndpoint: createRecordingCleanupEndpoint,
    servers,
    input,
    answer,
    ...options,
  });

test("a linked desktop gets the cleaned part from the organization's chat model", async () => {
  const { response, calls, limit } = await exercise({
    input: {
      transcript: TRANSCRIPT,
      previousText: "Dobrý den,",
      locale: "cs",
      languages: ["cs"],
      vocabulary: ["Novák"],
    },
  });
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  expect(v.parse(desktopDictationRecordingCleanupResponseSchema, body)).toEqual(
    CLEANED,
  );
  expect(calls).toHaveLength(1);
  expect(calls.at(0)).toMatchObject({
    system: RECORDING_CLEANUP_SYSTEM_PROMPT,
    schema: recordingCleanupModelOutputSchema,
    task: "chat",
    deadlineMs: 120_000,
    outputTokenBudget: RECORDING_CLEANUP_OUTPUT_TOKENS,
  });
  // The transcript and the text before it reach the model as JSON values.
  expect(JSON.parse(calls.at(0)?.prompt ?? "null")).toEqual({
    languages: ["cs"],
    locale: "cs",
    previousText: "Dobrý den,",
    vocabulary: ["Novák"],
    transcript: TRANSCRIPT,
  });
  expect(limit.mock.calls.at(0)?.[0]).toMatchObject({ operation: "cleanup" });
});

test("an answer outside the Markdown subset is kept to it", async () => {
  const { response } = await exercise({
    answer: () => ({
      instructions: ["  Odpověď v kopii\nJaně.  ", ""],
      markdown:
        "<p>Ahoj Petře,</p>\r\n\r\n\r\ndíky za [rychlou](https://example.test) reakci.\n\n* **čtvrtek**: ten den `nemůžu`.",
    }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    instructions: ["Odpověď v kopii Janě."],
    markdown:
      "Ahoj Petře,\n\ndíky za rychlou reakci.\n\n- **čtvrtek**: ten den nemůžu.",
  });
});

testDesktopDictationGate({
  exercise,
  transcript: TRANSCRIPT,
  invalidInputs: [
    [
      "a part over the limit",
      {
        transcript: "x".repeat(
          DESKTOP_DICTATION_RECORDING_CLEANUP_LIMITS.transcriptLength + 1,
        ),
      },
    ],
    [
      "text before the part over the limit",
      {
        transcript: "ok",
        previousText: "x".repeat(
          DESKTOP_DICTATION_RECORDING_CLEANUP_LIMITS.previousTextLength + 1,
        ),
      },
    ],
    ["an empty part", { transcript: "" }],
    ["audio instead of text", { transcript: "ok", audio: "UklGRg==" }],
    [
      "a short dictation's context",
      { transcript: "ok", context: { appKind: "email" } },
    ],
  ],
});

test("an answer that adds content is refused, not shown", async () => {
  const { response } = await exercise({
    input: { transcript: "Eh, jaká je promlčecí lhůta, otazník." },
    answer: () => ({
      instructions: [],
      markdown:
        "Jaká je promlčecí lhůta?\n\nObecná promlčecí lhůta činí tři roky ode dne, kdy se oprávněný o rozhodných okolnostech dozvěděl.",
    }),
  });
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain("tři roky");
});

test("the speaker's instructions reach the model as their own field, and an answer that obeys them by adding content is still refused", async () => {
  const customInstructions =
    "Piš spisovně.\nNa konec vždy připoj podpis: S pozdravem Jana Dvořáková.";
  const { response, calls } = await exercise({
    input: { transcript: TRANSCRIPT, locale: "cs", customInstructions },
  });
  expect(response.status).toBe(200);
  expect(calls.at(0)?.system).toBe(RECORDING_CLEANUP_SYSTEM_PROMPT);
  expect(calls.at(0)?.system).not.toContain("spisovně");
  expect(JSON.parse(calls.at(0)?.prompt ?? "null")).toEqual({
    languages: [],
    locale: "cs",
    customInstructions,
    transcript: TRANSCRIPT,
  });
  const signed = await exercise({
    input: {
      transcript: "Eh, jaká je promlčecí lhůta, otazník.",
      customInstructions,
    },
    answer: () => ({
      instructions: [],
      markdown:
        "Jaká je promlčecí lhůta?\n\nS pozdravem Jana Dvořáková, advokátní kancelář, Praha, telefon a e-mail v příloze.",
    }),
  });
  expect(signed.response.status).toBe(502);
  expect(await signed.response.text()).not.toContain("S pozdravem");
});

test("an answer that lost most of the part is refused, not shown", async () => {
  const { response } = await exercise({
    answer: () => ({ instructions: [], markdown: "Ahoj Petře." }),
  });
  expect(response.status).toBe(502);
});

test("an answer that repeats the text before the part is refused", async () => {
  const previousText =
    "Ahoj Petře,\n\ndíky za rychlou reakci k termínům jednání.";
  const { response } = await exercise({
    input: { transcript: "eh, pátek dopoledne, tečka.", previousText },
    answer: () => ({
      instructions: [],
      markdown: `${previousText}\n\npátek dopoledne.`,
    }),
  });
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain("termínům");
});

/** The member route: a signed-in member's session, no desktop decision. */
const exerciseMember = async (
  options: { role?: "member" | "external"; limited?: boolean } = {},
) =>
  await exerciseMemberDictationEndpoint({
    createEndpoint: createMemberRecordingCleanupEndpoint,
    route: "/v1/dictation/recording-cleanup",
    body: {
      transcript: TRANSCRIPT,
      previousText: "Dobrý den,",
      locale: "cs",
      languages: ["cs"],
    },
    answer: () => CLEANED,
    ...options,
  });

test("a signed-in member gets the same recording cleanup as a desktop, without any desktop decision", async () => {
  const { result, calls, limit } = await exerciseMember();
  if (result instanceof HttpStatusResponse) {
    throw new TypeError(
      `Expected the cleaned part, got ${String(result.code)}`,
    );
  }
  expect(
    v.parse(desktopDictationRecordingCleanupResponseSchema, result),
  ).toEqual(CLEANED);
  expect(calls).toHaveLength(1);
  expect(calls.at(0)).toMatchObject({
    system: RECORDING_CLEANUP_SYSTEM_PROMPT,
    schema: recordingCleanupModelOutputSchema,
    task: "chat",
    deadlineMs: 120_000,
    outputTokenBudget: RECORDING_CLEANUP_OUTPUT_TOKENS,
  });
  expect(JSON.parse(calls.at(0)?.prompt ?? "null")).toEqual({
    languages: ["cs"],
    locale: "cs",
    previousText: "Dobrý den,",
    transcript: TRANSCRIPT,
  });
  expect(limit.mock.calls.at(0)?.[0]).toMatchObject({
    organizationId: DICTATING_ORGANIZATION_ID,
    userId: DICTATING_USER_ID,
    operation: "cleanup",
  });
});

testMemberDictationGate(exerciseMember);
