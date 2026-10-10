import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { organization, user } from "@/api/db/auth-schema";
import type { SafeDb } from "@/api/db/safe-db";
import { legalReaderAnswerMessages, legalReaderAnswers } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { deleteReaderAnswerHandler } from "@/api/handlers/legal-reader/answers/delete";
import { prepareReaderAnswer } from "@/api/handlers/legal-reader/answers/operation";
import type { ReaderAnswerCommand } from "@/api/handlers/legal-reader/answers/operation";
import { streamReaderAnswer } from "@/api/handlers/legal-reader/answers/stream";
import type { ReaderAnswerStreamOptions } from "@/api/handlers/legal-reader/answers/stream";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { createSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { testModelActionAdmitter } from "@/api/tests/helpers/model-dispatch-admission";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getTestDb,
  releaseTestDb,
  withQueryLogger,
  type TestDatabase,
} from "@/api/tests/security/test-utils";

const organizationId = mintAuthProviderId<"organization">();
const userId = mintAuthProviderId<"user">();
const decisionId = createSafeId<"caseLawDecision">();
const relatedId = createSafeId<"caseLawDecision">();
const anchor = {
  paragraphId: "p-1",
  quote: "The holding",
  startOffset: 0,
  endOffset: 11,
};
let database: TestDatabase;

beforeAll(async () => {
  database = await getTestDb();
  await database.insert(user).values({
    id: userId,
    name: "Reader",
    email: `${userId}@example.test`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await database.insert(organization).values({
    id: organizationId,
    name: "Reader organization",
    slug: `reader-runtime-${organizationId}`,
    createdAt: new Date(),
  });
});
afterAll(releaseTestDb);

const scope = (activeDatabase = database) => ({
  organizationId,
  userId,
  recordAuditEvent: async () => undefined,
  safeDb: asTestRaw<SafeDb>(
    createSafeDb(activeDatabase, [], organizationId, userId),
  ),
});
const prepare = async (
  command: ReaderAnswerCommand,
  activeDatabase = database,
) => {
  const result = await prepareReaderAnswer({
    ...scope(activeDatabase),
    command,
    readDecision: async () =>
      Result.ok({
        decisionId,
        paragraphs: [{ paragraphId: "p-1", text: "The holding follows." }],
      }),
  });
  expect(Result.isOk(result)).toBe(true);
  if (Result.isError(result)) {
    throw result.error;
  }
  return result.value;
};
const create = async (activeDatabase = database) =>
  await prepare(
    {
      type: "create",
      body: { kind: "explain", decisionId, anchor, locale: "cs-CZ" },
    },
    activeDatabase,
  );
const complete = async (
  prepared: ReaderAnswerStreamOptions["prepared"],
  overrides: Partial<ReaderAnswerStreamOptions> = {},
) => {
  const response = streamReaderAnswer({
    ...scope(),
    prepared,
    orgAIConfig: null,
    managedAIResidency: "eu",
    requestSignal: new AbortController().signal,
    admitModelAction: testModelActionAdmitter(organizationId),
    runModel: async ({ onDelta }) => {
      onDelta("The explanation");
      return Result.ok({
        content: `The explanation [[${decisionId}#p-1]].`,
        model: "fixture-model",
        usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
      });
    },
    ...overrides,
  });
  return { response, text: await response.text() };
};
const message = async (prepared: ReaderAnswerStreamOptions["prepared"]) =>
  (
    await database
      .select()
      .from(legalReaderAnswerMessages)
      .where(eq(legalReaderAnswerMessages.id, prepared.messageId))
  ).at(0);

describe("reader answer turn lifecycle", () => {
  test("rejects offset spans outside the paragraph even when JavaScript slicing clamps them", async () => {
    const text = "The holding follows.";
    const invalidAnchors = [
      {
        paragraphId: "p-1",
        startOffset: -1,
        endOffset: text.length,
        quote: ".",
      },
      { paragraphId: "p-1", startOffset: 4, endOffset: 4, quote: "" },
      {
        paragraphId: "p-1",
        startOffset: 4,
        endOffset: text.length + 100,
        quote: "holding follows.",
      },
    ];
    for (const invalidAnchor of invalidAnchors) {
      expect(
        text.slice(invalidAnchor.startOffset, invalidAnchor.endOffset),
      ).toBe(invalidAnchor.quote);
      const result = await prepareReaderAnswer({
        ...scope(),
        command: {
          type: "create",
          body: {
            kind: "explain",
            decisionId,
            anchor: invalidAnchor,
            locale: "cs-CZ",
          },
        },
        readDecision: async () =>
          Result.ok({ decisionId, paragraphs: [{ paragraphId: "p-1", text }] }),
      });
      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error).toMatchObject({
          status: 400,
          message: "Selection does not match the decision paragraph",
        });
      }
    }
  });

  test("a pending streaming turn refuses follow-up and regeneration without adding messages", async () => {
    const prepared = await create();
    for (const command of [
      {
        type: "follow-up",
        answerId: prepared.answer.id,
        body: { question: "Another question", locale: "cs-CZ" },
      },
      {
        type: "regenerate",
        answerId: prepared.answer.id,
        body: { locale: "cs-CZ" },
      },
    ] as const) {
      const result = await prepareReaderAnswer({
        ...scope(),
        command,
        readDecision: async () =>
          Result.ok({
            decisionId,
            paragraphs: [{ paragraphId: "p-1", text: "The holding follows." }],
          }),
      });
      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error).toMatchObject({
          status: 409,
          message: "A reader answer is already streaming",
        });
      }
    }
    const messages = await database
      .select()
      .from(legalReaderAnswerMessages)
      .where(eq(legalReaderAnswerMessages.answerId, prepared.answer.id));
    expect(messages).toHaveLength(2);
    expect(await message(prepared)).toMatchObject({
      status: "streaming",
      content: "",
    });
    await complete(prepared);
  });

  test("creating and regenerating an explanation write only reader thread storage", async () => {
    const statements: string[] = [];
    const observedDatabase = withQueryLogger(database, {
      logQuery: (query) => {
        statements.push(query);
      },
    });
    const prepared = await create(observedDatabase);
    await complete(prepared, { safeDb: scope(observedDatabase).safeDb });
    const regenerated = await prepare(
      {
        type: "regenerate",
        answerId: prepared.answer.id,
        body: { locale: "cs-CZ" },
      },
      observedDatabase,
    );
    await complete(regenerated, { safeDb: scope(observedDatabase).safeDb });
    expect(
      statements.some((statement) =>
        statement.includes('insert into "legal_reader_answers"'),
      ),
    ).toBe(true);
    expect(
      statements.some((statement) =>
        statement.includes('update "legal_reader_answer_messages"'),
      ),
    ).toBe(true);
    expect(
      statements.filter((statement) =>
        /case_law_decisions|stored[_-]analysis/iu.test(statement),
      ),
    ).toEqual([]);
  });
  test("deleting an answer permanently removes the thread and its messages", async () => {
    const prepared = await create();
    await complete(prepared);
    const removed = await deleteReaderAnswerHandler({
      ...scope(),
      answerId: prepared.answer.id,
    });
    expect(Result.isOk(removed)).toBe(true);
    expect(await message(prepared)).toBeUndefined();
    const answers = await database
      .select()
      .from(legalReaderAnswers)
      .where(eq(legalReaderAnswers.id, prepared.answer.id));
    expect(answers).toEqual([]);
  });
  test("streams text and persists the same final citation, model and usage", async () => {
    const prepared = await create();
    const { response, text } = await complete(prepared);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(text).toContain('"type":"started"');
    expect(text).toContain('"type":"delta"');
    expect(text).toContain('"type":"complete"');
    expect(await message(prepared)).toMatchObject({
      status: "complete",
      content: `The explanation [[${decisionId}#p-1]].`,
      citations: [{ decisionId, paragraphId: "p-1" }],
      model: "fixture-model",
      usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
    });
  });

  test("a refused budget does not dispatch a model and persists a failed turn", async () => {
    const prepared = await create();
    let called = false;
    const { text } = await complete(prepared, {
      admitModelAction: async () =>
        Result.err(
          new HandlerError({ status: 429, message: "Budget exhausted" }),
        ),
      runModel: async () => {
        called = true;
        return Result.ok({
          content: "Unexpected",
          model: "fixture",
          usage: null,
        });
      },
    });
    expect(called).toBe(false);
    expect(text).toContain('"type":"failed"');
    expect(await message(prepared)).toMatchObject({
      status: "failed",
      content: "",
      citations: [],
    });
  });

  test("model failures settle streaming messages as failed", async () => {
    const prepared = await create();
    const { text } = await complete(prepared, {
      runModel: async () =>
        Result.err(
          new HandlerError({ status: 502, message: "Provider unavailable" }),
        ),
    });
    expect(text).toContain('"type":"failed"');
    expect(await message(prepared)).toMatchObject({ status: "failed" });
  });

  test("a failed stream preserves sanitized partial content identically on reload", async () => {
    const prepared = await create();
    const { text } = await complete(prepared, {
      runModel: async ({ onDelta, onEvidence }) => {
        onEvidence([{ decisionId: relatedId, paragraphId: "p-7" }]);
        onDelta(`Holding [[${decisionId}#p-1]]. `);
        onDelta(
          `Related [[${relatedId}#p-7]]. Invented [[${relatedId}#p-99]].`,
        );
        return Result.err(
          new HandlerError({ status: 502, message: "Provider interrupted" }),
        );
      },
    });
    const stored = await message(prepared);
    expect(stored).toMatchObject({
      status: "failed",
      content: `Holding [[${decisionId}#p-1]]. Related [[${relatedId}#p-7]]. Invented .`,
      citations: [
        { decisionId, paragraphId: "p-1" },
        { decisionId: relatedId, paragraphId: "p-7" },
      ],
    });
    const events: unknown[] = text
      .split("\n\n")
      .filter((entry) => entry.startsWith("data: "))
      .map((entry) => JSON.parse(entry.slice(6)));
    const failed = events.find(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        "type" in event &&
        event.type === "failed",
    );
    expect(failed).toEqual({
      type: "failed",
      messageId: prepared.messageId,
      message: "Reader answer generation failed",
      content: stored?.content,
      citations: stored?.citations,
      invalidCitationCount: 1,
    });
    expect(text).not.toContain('"type":"complete"');
  });

  test("a failed answer can regenerate successfully with a fresh message identity", async () => {
    const first = await create();
    await complete(first, {
      runModel: async () =>
        Result.err(
          new HandlerError({ status: 502, message: "Provider unavailable" }),
        ),
    });
    const regenerated = await prepare({
      type: "regenerate",
      answerId: first.answer.id,
      body: { locale: "cs-CZ" },
    });
    expect(regenerated.messageId).not.toBe(first.messageId);
    expect(await message(first)).toBeUndefined();
    expect(regenerated.history.map(({ role }) => role)).toEqual(["user"]);
    await complete(regenerated);
    expect(await message(regenerated)).toMatchObject({ status: "complete" });
  });

  test("request cancellation prevents a model result from completing its message", async () => {
    const prepared = await create();
    const controller = new AbortController();
    controller.abort();
    const { text } = await complete(prepared, {
      requestSignal: controller.signal,
    });
    expect(text).toContain('"type":"failed"');
    expect(text).not.toContain('"type":"complete"');
    expect(await message(prepared)).toMatchObject({
      status: "failed",
      content: "The explanation",
    });
  });

  test("a reclaimed stream cannot settle or fail a newer regeneration claim", async () => {
    const first = await create();
    const staleAt = new Date("2000-01-01T00:00:00Z");
    await database
      .update(legalReaderAnswerMessages)
      .set({ updatedAt: staleAt })
      .where(eq(legalReaderAnswerMessages.id, first.messageId));
    const stale = first;
    const regenerated = await prepare({
      type: "regenerate",
      answerId: first.answer.id,
      body: { locale: "cs-CZ" },
    });
    expect(regenerated.messageId).not.toBe(stale.messageId);
    expect(await message(stale)).toBeUndefined();
    const old = await complete(stale);
    expect(old.text).toContain('"type":"failed"');
    expect(await message(regenerated)).toMatchObject({
      status: "streaming",
      content: "",
    });
    await complete(regenerated);
    expect(await message(regenerated)).toMatchObject({ status: "complete" });
  });

  test("validates both decision and paragraph identities against supplied evidence", async () => {
    const prepared = await create();
    const { text } = await complete(prepared, {
      runModel: async ({ onEvidence }) => {
        onEvidence([{ decisionId: relatedId, paragraphId: "p-7" }]);
        return Result.ok({
          content: `Related [[${relatedId}#p-7]]. Invented [[${relatedId}#p-99]].`,
          model: "fixture",
          usage: null,
        });
      },
    });
    expect(text).toContain('"invalidCitationCount":1');
    expect(await message(prepared)).toMatchObject({
      content: `Related [[${relatedId}#p-7]]. Invented .`,
      citations: [{ decisionId: relatedId, paragraphId: "p-7" }],
    });
  });

  test("follow-up preserves history and regeneration replaces the final assistant message", async () => {
    const first = await create();
    await complete(first);
    const followUp = await prepare({
      type: "follow-up",
      answerId: first.answer.id,
      body: { question: "What follows?", locale: "cs-CZ" },
    });
    expect(followUp.history.map(({ role }) => role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    await complete(followUp);
    const regenerated = await prepare({
      type: "regenerate",
      answerId: first.answer.id,
      body: { locale: "cs-CZ" },
    });
    expect(regenerated.messageId).not.toBe(followUp.messageId);
    expect(await message(followUp)).toBeUndefined();
    expect(regenerated.history.map(({ role }) => role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(await message(regenerated)).toMatchObject({
      status: "streaming",
      content: "",
      citations: [],
      model: null,
      usage: null,
    });
    await complete(regenerated);
    expect(await message(regenerated)).toMatchObject({ status: "complete" });
  });

  test("passes organization provider configuration and requested model to the admitted runner", async () => {
    const prepared = await prepare({
      type: "create",
      body: {
        kind: "ask",
        question: "Why?",
        decisionId,
        anchor,
        locale: "en-GB",
        modelId: "openai/gpt-4.1",
      },
    });
    const config = {
      providers: [{ provider: "openai", apiKey: "fixture-key" }],
      overrideModels: null,
      decision: null,
    } satisfies OrgAIConfig;
    let called = false;
    await complete(prepared, {
      orgAIConfig: config,
      runModel: async (input) => {
        called = true;
        expect(input.orgAIConfig).toBe(config);
        expect(input.modelId).toBe("openai/gpt-4.1");
        expect(input.admission.organizationId).toBe(organizationId);
        return Result.ok({
          content: "A configured response",
          model: "openai/gpt-4.1",
          usage: null,
        });
      },
    });
    expect(called).toBe(true);
    expect(await message(prepared)).toMatchObject({
      status: "complete",
      model: "openai/gpt-4.1",
    });
  });

  test("uses the budget fallback model and meters the admitted lane", async () => {
    const prepared = await prepare({
      type: "create",
      body: {
        kind: "ask",
        question: "Why?",
        decisionId,
        anchor,
        locale: "en-GB",
        modelId: "requested-model",
      },
    });
    let called = false;
    await complete(prepared, {
      usageLane: { lane: "fallback", forcedModelSelection: "fallback-model" },
      runModel: async (input) => {
        called = true;
        expect(input.modelId).toBe("fallback-model");
        expect(input.metering.lane).toBe("fallback");
        return Result.ok({
          content: "A metered response",
          model: "fallback-model",
          usage: null,
        });
      },
    });
    expect(called).toBe(true);
    expect(await message(prepared)).toMatchObject({
      status: "complete",
      model: "fallback-model",
    });
  });

  test("meters the allowance lane while preserving the requested model", async () => {
    const prepared = await prepare({
      type: "create",
      body: {
        kind: "ask",
        question: "Why?",
        decisionId,
        anchor,
        locale: "en-GB",
        modelId: "requested-model",
      },
    });
    let called = false;
    await complete(prepared, {
      usageLane: { lane: "allowance" },
      runModel: async (input) => {
        called = true;
        expect(input.modelId).toBe("requested-model");
        expect(input.metering.lane).toBe("allowance");
        return Result.ok({
          content: "An allowance response",
          model: "requested-model",
          usage: null,
        });
      },
    });
    expect(called).toBe(true);
    expect(await message(prepared)).toMatchObject({
      status: "complete",
      model: "requested-model",
    });
  });
});
