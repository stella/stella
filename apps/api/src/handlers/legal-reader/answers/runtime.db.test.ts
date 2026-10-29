import { Result } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import { asc, eq } from "drizzle-orm";
import * as v from "valibot";

import { ACTION_ADMISSION_CODES } from "@stll/api-contract/action-admission";
import {
  READER_ANSWER_ANCHOR_MISMATCH_CODE,
  READER_ANSWER_DEADLINE_MS,
  READER_ANSWER_ERROR_CODES,
  READER_ANSWER_MAX_MESSAGES,
  type ReaderAnswerSpans,
} from "@stll/api-contract/reader-answers";
import { sleep } from "@stll/concurrency/sleep";
import type { Block } from "@stll/legal-ast/document-ast";

import { organization, user } from "@/api/db/auth-schema";
import type { SafeDb } from "@/api/db/safe-db";
import { legalReaderAnswerMessages, legalReaderAnswers } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { deleteReaderAnswerHandler } from "@/api/handlers/legal-reader/answers/delete";
import { listReaderAnswersHandler } from "@/api/handlers/legal-reader/answers/list";
import { prepareReaderAnswer } from "@/api/handlers/legal-reader/answers/operation";
import type { ReaderAnswerCommand } from "@/api/handlers/legal-reader/answers/operation";
import { streamReaderAnswer } from "@/api/handlers/legal-reader/answers/stream";
import type { ReaderAnswerStreamOptions } from "@/api/handlers/legal-reader/answers/stream";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { readReaderAnswerDecision } from "@/api/lib/case-law/reader-answer-corpus";
import { ActionAdmissionError } from "@/api/lib/errors/action-admission-error";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { testModelActionAdmitter } from "@/api/tests/helpers/model-dispatch-admission";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getTestDb,
  releaseTestDb,
  type TestDatabase,
  withQueryLogger,
} from "@/api/tests/security/test-utils";

const organizationId = mintAuthProviderId<"organization">();
const userId = mintAuthProviderId<"user">();
const decisionId = createSafeId<"caseLawDecision">();
const relatedId = createSafeId<"caseLawDecision">();
const anchor = {
  spans: [
    {
      paragraphId: "p-1",
      quote: "The holding",
      startOffset: 0,
      endOffset: 11,
    },
  ],
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
afterEach(() => setSystemTime());

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
        court: "Test court",
        decisionDate: "2026-01-01",
        language: "cs",
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
  const text = await response.text();
  terminalEvents(text);
  return { response, text };
};
const message = async (prepared: ReaderAnswerStreamOptions["prepared"]) =>
  (
    await database
      .select()
      .from(legalReaderAnswerMessages)
      .where(eq(legalReaderAnswerMessages.id, prepared.messageId))
  ).at(0);

const reloadThread = async (
  prepared: ReaderAnswerStreamOptions["prepared"],
) => {
  const result = await Result.gen(async function* () {
    return yield* listReaderAnswersHandler({
      ...scope(),
      query: { decisionId, limit: 100 },
    });
  });
  if (result.isErr()) {
    throw result.error;
  }
  const thread = result.value.items.find(({ id }) => id === prepared.answer.id);
  expect(thread).toBeDefined();
  return thread;
};
const reload = async (prepared: ReaderAnswerStreamOptions["prepared"]) => {
  const thread = await reloadThread(prepared);
  const assistant = thread?.messages.find(
    ({ id }) => id === prepared.messageId,
  );
  expect(assistant).toBeDefined();
  expect(
    thread?.messages
      .filter(({ role }) => role === "user")
      .every(
        (entry) => entry.errorCode === null && entry.invalidCitationCount === 0,
      ),
  ).toBe(true);
  return assistant;
};
const terminalEvents = (text: string) =>
  text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) =>
      v.parse(
        v.variant("type", [
          v.object({ type: v.literal("started") }),
          v.object({ type: v.literal("delta") }),
          v.object({
            type: v.literal("complete"),
            content: v.string(),
            invalidCitationCount: v.number(),
            errorCode: v.optional(v.picklist(READER_ANSWER_ERROR_CODES)),
          }),
          v.object({
            type: v.literal("failed"),
            content: v.string(),
            invalidCitationCount: v.number(),
            errorCode: v.picklist(READER_ANSWER_ERROR_CODES),
          }),
        ]),
        JSON.parse(line.slice(6)),
      ),
    )
    .filter((event) => event.type === "complete" || event.type === "failed");

describe("reader answer turn lifecycle", () => {
  test.each(["complete", "failed"] as const)(
    "audits a %s settlement inside the message transaction",
    async (status) => {
      const prepared = await create();
      let auditCalls = 0;
      await complete(prepared, {
        runModel: async () =>
          status === "complete"
            ? Result.ok({
                content: "The explanation",
                model: "fixture-model",
                usage: null,
              })
            : Result.err(
                new HandlerError({
                  status: 502,
                  code: "internal_error",
                  message: "Provider unavailable",
                }),
              ),
        recordAuditEvent: async (tx, event) => {
          auditCalls++;
          expect(event).toMatchObject({
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.CASE_LAW_READER_ANSWER,
            resourceId: prepared.answer.id,
          });
          const saved = (
            await tx
              .select({ status: legalReaderAnswerMessages.status })
              .from(legalReaderAnswerMessages)
              .where(eq(legalReaderAnswerMessages.id, prepared.messageId))
          ).at(0);
          expect(saved?.status).toBe(status);
        },
      });
      expect(auditCalls).toBe(1);
      expect((await message(prepared))?.status).toBe(status);
    },
  );

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
            anchor: { spans: [invalidAnchor] },
            locale: "cs-CZ",
          },
        },
        readDecision: async () =>
          Result.ok({
            decisionId,
            court: "Test court",
            decisionDate: "2026-01-01",
            language: "cs",
            paragraphs: [{ paragraphId: "p-1", text }],
          }),
      });
      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error).toMatchObject({
          status: 400,
          code: READER_ANSWER_ANCHOR_MISMATCH_CODE,
          message: "Selection does not match the decision paragraph",
        });
      }
    }
  });

  test("a selection over several paragraphs, past any length cap, persists and reloads every span", async () => {
    const long = "Reasoning ".repeat(500);
    const paragraphs = [
      { paragraphId: "p-1", text: "The facts. The holding" },
      { paragraphId: "p-2", text: long },
      { paragraphId: "p-3", text: "follows here." },
    ];
    const spans = [
      {
        paragraphId: "p-1",
        quote: "The holding",
        startOffset: 11,
        endOffset: 22,
      },
      {
        paragraphId: "p-2",
        quote: long,
        startOffset: 0,
        endOffset: long.length,
      },
      { paragraphId: "p-3", quote: "follows", startOffset: 0, endOffset: 7 },
    ] satisfies ReaderAnswerSpans;
    const result = await prepareReaderAnswer({
      ...scope(),
      command: {
        type: "create",
        body: {
          kind: "explain",
          decisionId,
          anchor: { spans },
          locale: "cs-CZ",
        },
      },
      readDecision: async () =>
        Result.ok({
          decisionId,
          court: "Test court",
          decisionDate: "2026-01-01",
          language: "cs",
          paragraphs,
        }),
    });
    if (Result.isError(result)) {
      throw result.error;
    }
    expect(result.value.anchor).toEqual(spans);
    expect((await reloadThread(result.value))?.anchor).toEqual({ spans });
  });

  test("refuses spans that repeat a paragraph, run against reading order or are empty", async () => {
    const paragraphs = [
      { paragraphId: "p-1", text: "The holding" },
      { paragraphId: "p-2", text: "follows here." },
    ];
    const first = {
      paragraphId: "p-1",
      quote: "The holding",
      startOffset: 0,
      endOffset: 11,
    };
    const second = {
      paragraphId: "p-2",
      quote: "follows",
      startOffset: 0,
      endOffset: 7,
    };
    for (const spans of [[second, first], [first, first], []]) {
      const result = await prepareReaderAnswer({
        ...scope(),
        command: {
          type: "create",
          body: {
            kind: "explain",
            decisionId,
            anchor: { spans },
            locale: "cs-CZ",
          },
        },
        readDecision: async () =>
          Result.ok({
            decisionId,
            court: "Test court",
            decisionDate: "2026-01-01",
            language: "cs",
            paragraphs,
          }),
      });
      expect(Result.isError(result) && result.error).toMatchObject({
        status: 400,
        code: READER_ANSWER_ANCHOR_MISMATCH_CODE,
      });
    }
  });

  test("explains a selection in every block kind the reader anchors, from create through the stream", async () => {
    const blocks: Block[] = [
      {
        type: "heading",
        id: "heading",
        anchorId: "h-1",
        level: 2,
        inlines: [{ type: "text", text: "Odůvodnění" }],
        plainText: "Odůvodnění",
      },
      {
        type: "paragraph",
        id: "footnote",
        anchorId: "fn-1",
        note: { type: "footnote", label: "1" },
        inlines: [{ type: "text", text: "Poznámka soudu." }],
        plainText: "Poznámka soudu.",
      },
      {
        type: "table",
        id: "table",
        anchorId: "t-1",
        rows: [
          [
            {
              inlines: [{ type: "text", text: "Spisová značka" }],
              plainText: "Spisová značka",
            },
          ],
        ],
        plainText: "Spisová značka",
      },
    ];
    // The decision as the reader source returns it, read through the real
    // corpus mapping rather than a hand-written paragraph list.
    const readDecision = async () =>
      await readReaderAnswerDecision(decisionId, {
        readDecision: async () =>
          asTestRaw({
            status: "read",
            ast: { blocks, metadata: {} },
            decision: {
              id: decisionId,
              caseNumberType: "case-number",
              court: "Test court",
              decisionDate: "2026-01-01",
            },
          }),
      });
    for (const { anchorId, text } of [
      { anchorId: "h-1", text: "Odůvodnění" },
      { anchorId: "fn-1", text: "Poznámka soudu." },
      { anchorId: "table:table:0:0", text: "Spisová značka" },
    ]) {
      const quote = text.slice(1);
      const prepared = await prepareReaderAnswer({
        ...scope(),
        command: {
          type: "create",
          body: {
            kind: "explain",
            decisionId,
            anchor: {
              spans: [
                {
                  paragraphId: anchorId,
                  quote,
                  startOffset: 1,
                  endOffset: text.length,
                },
              ],
            },
            locale: "cs-CZ",
          },
        },
        readDecision,
      });
      if (Result.isError(prepared)) {
        throw prepared.error;
      }
      const { text: streamed } = await complete(prepared.value, {
        runModel: async ({ onDelta }) => {
          onDelta("The explanation");
          return Result.ok({
            content: `The explanation [[${decisionId}#${anchorId}]].`,
            model: "fixture-model",
            usage: null,
          });
        },
      });
      expect(terminalEvents(streamed)).toEqual([
        expect.objectContaining({ type: "complete", invalidCitationCount: 0 }),
      ]);
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
            court: "Test court",
            decisionDate: "2026-01-01",
            language: "cs",
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

  test("a thread holding more messages than the cap refuses regeneration instead of reading a truncated history", async () => {
    const prepared = await create();
    await complete(prepared);
    const extra = Array.from(
      { length: READER_ANSWER_MAX_MESSAGES - 1 },
      (_, index) => ({
        id: createSafeId<"legalReaderAnswerMessage">(),
        answerId: prepared.answer.id,
        sequence: index + 3,
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: `Message ${index + 3}`,
        status: "complete" as const,
      }),
    );
    await database.insert(legalReaderAnswerMessages).values(extra);
    const before = await database
      .select()
      .from(legalReaderAnswerMessages)
      .where(eq(legalReaderAnswerMessages.answerId, prepared.answer.id))
      .orderBy(asc(legalReaderAnswerMessages.sequence));
    expect(before).toHaveLength(READER_ANSWER_MAX_MESSAGES + 1);

    const result = await prepareReaderAnswer({
      ...scope(),
      command: {
        type: "regenerate",
        answerId: prepared.answer.id,
        body: { locale: "cs-CZ" },
      },
      readDecision: async () =>
        Result.ok({
          decisionId,
          court: "Test court",
          decisionDate: "2026-01-01",
          language: "cs",
          paragraphs: [{ paragraphId: "p-1", text: "The holding follows." }],
        }),
    });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toMatchObject({
        status: 409,
        message: "Reader answer thread has reached its message limit",
      });
    }
    expect(
      await database
        .select()
        .from(legalReaderAnswerMessages)
        .where(eq(legalReaderAnswerMessages.answerId, prepared.answer.id))
        .orderBy(asc(legalReaderAnswerMessages.sequence)),
    ).toEqual(before);
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
        statement
          .toLowerCase()
          .includes('update "legal_reader_answer_messages"'),
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

  test.each([
    {
      reason: "period_exhausted",
      code: ACTION_ADMISSION_CODES.periodExhausted,
    },
    { reason: "busy", code: ACTION_ADMISSION_CODES.concurrencyBusy },
    { reason: "not_enabled", code: ACTION_ADMISSION_CODES.notEnabled },
    {
      reason: "store_unavailable",
      code: ACTION_ADMISSION_CODES.storeUnavailable,
    },
    {
      reason: "configuration_incomplete",
      code: ACTION_ADMISSION_CODES.configurationIncomplete,
    },
    {
      reason: "organization_state_unreadable",
      code: ACTION_ADMISSION_CODES.organizationStateUnreadable,
    },
    { reason: "lease_lost", code: ACTION_ADMISSION_CODES.leaseLost },
  ] as const)(
    "admission $reason persists its precise recovery code on stream and reload",
    async ({ reason, code }) => {
      const prepared = await create();
      let called = false;
      const { text } = await complete(prepared, {
        admitModelAction: async () =>
          Result.err(
            new ActionAdmissionError({
              reason,
              message: "Fixture admission refusal",
            }),
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
      expect(terminalEvents(text)).toEqual([
        {
          type: "failed",
          content: "",
          errorCode: code,
          invalidCitationCount: 0,
        },
      ]);
      expect(await message(prepared)).toMatchObject({
        status: "failed",
        content: "",
        citations: [],
        errorCode: code,
        invalidCitationCount: 0,
      });
      expect(await reload(prepared)).toMatchObject({
        status: "failed",
        errorCode: code,
        invalidCitationCount: 0,
      });
    },
  );

  test("an unclassified admission failure persists an internal error without claiming a store outage", async () => {
    const prepared = await create();
    const { text } = await complete(prepared, {
      admitModelAction: async () => {
        throw new HandlerError({
          status: 500,
          code: "internal_error",
          message: "Admission failed",
        });
      },
    });
    expect(terminalEvents(text).at(0)?.errorCode).toBe("internal");
    expect(await message(prepared)).toMatchObject({
      status: "failed",
      errorCode: "internal",
    });
    expect(await reload(prepared)).toMatchObject({
      status: "failed",
      errorCode: "internal",
    });
  });

  test("model failures settle streaming messages as failed", async () => {
    const prepared = await create();
    const { text } = await complete(prepared, {
      runModel: async () =>
        Result.err(
          new HandlerError({
            status: 502,
            code: "internal_error",
            message: "Provider unavailable",
          }),
        ),
    });
    expect(text).toContain('"type":"failed"');
    expect(await message(prepared)).toMatchObject({
      status: "failed",
      errorCode: "provider-error",
      invalidCitationCount: 0,
    });
    expect(terminalEvents(text).at(0)?.errorCode).toBe("provider-error");
    expect(await reload(prepared)).toMatchObject({
      status: "failed",
      errorCode: "provider-error",
      invalidCitationCount: 0,
    });
  });

  test("a double settlement failure emits a safe terminal error and leaves the claim recoverable", async () => {
    const prepared = await create();
    let writes = 0;
    let audits = 0;
    const { text } = await complete(prepared, {
      safeDb: async () => {
        writes++;
        return Result.err(
          new DatabaseError({ message: "PRIVATE_DATABASE_FAILURE_DETAIL" }),
        );
      },
      recordAuditEvent: async () => {
        audits++;
      },
      runModel: async ({ onDelta, onEvidence }) => {
        onEvidence([{ decisionId: relatedId, paragraphId: "p-7" }]);
        const content = `Related [[${relatedId}#p-7]]. Invented [[${relatedId}#p-99]].`;
        onDelta(content);
        return Result.ok({ content, model: "fixture", usage: null });
      },
    });
    expect(writes).toBe(2);
    expect(audits).toBe(0);
    expect(terminalEvents(text)).toEqual([
      {
        type: "failed",
        content: `Related [[${relatedId}#p-7]]. Invented .`,
        errorCode: "persistence",
        invalidCitationCount: 1,
      },
    ]);
    const events: unknown[] = text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)));
    expect(
      events.find(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          "type" in event &&
          event.type === "failed",
      ),
    ).toEqual({
      type: "failed",
      messageId: prepared.messageId,
      message: "Reader answer generation failed",
      errorCode: "persistence",
      content: `Related [[${relatedId}#p-7]]. Invented .`,
      citations: [{ decisionId: relatedId, paragraphId: "p-7" }],
      invalidCitationCount: 1,
    });
    expect(text).not.toContain("PRIVATE_DATABASE_FAILURE_DETAIL");
    expect(await message(prepared)).toMatchObject({
      status: "streaming",
      content: "",
      errorCode: null,
      invalidCitationCount: 0,
    });
    expect(await reload(prepared)).toMatchObject({
      status: "streaming",
      errorCode: null,
      invalidCitationCount: 0,
    });
    await database
      .update(legalReaderAnswerMessages)
      .set({ updatedAt: new Date(Date.now() - READER_ANSWER_DEADLINE_MS - 1) })
      .where(eq(legalReaderAnswerMessages.id, prepared.messageId));
    const followUp = await prepare({
      type: "follow-up",
      answerId: prepared.answer.id,
      body: { question: "Continue after recovery?", locale: "cs-CZ" },
    });
    expect(await message(prepared)).toMatchObject({
      status: "failed",
      errorCode: "owner-lost",
    });
    await complete(followUp);
    expect(await reload(followUp)).toMatchObject({
      status: "complete",
      errorCode: null,
    });
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
          new HandlerError({
            status: 502,
            code: "internal_error",
            message: "Provider interrupted",
          }),
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
      errorCode: "provider-error",
    });
    expect(await reload(prepared)).toMatchObject({
      content: stored?.content,
      citations: stored?.citations,
      errorCode: "provider-error",
      invalidCitationCount: 1,
    });
    expect(text).not.toContain('"type":"complete"');
  });

  test("a failed answer can regenerate successfully with a fresh message identity", async () => {
    const first = await create();
    await complete(first, {
      runModel: async () =>
        Result.err(
          new HandlerError({
            status: 502,
            code: "internal_error",
            message: "Provider unavailable",
          }),
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
      content: "",
    });
  });

  test.each(["waiting-admission", "active-generation"] as const)(
    "claim expiry fences %s from a concurrent regeneration",
    async (phase) => {
      const realNow = Date.now();
      setSystemTime(new Date(realNow - READER_ANSWER_DEADLINE_MS + 400));
      const first = await create();
      setSystemTime();
      let active = 0;
      let maxActive = 0;
      let oldDispatches = 0;
      let admissionCallbacks = 0;
      const waitUntil = async (at: number) => {
        await sleep(Math.max(0, at - Date.now()));
      };
      const old = complete(first, {
        admitModelAction: async (run) => {
          await waitUntil(
            phase === "waiting-admission"
              ? first.deadlineAt + 80
              : first.deadlineAt - 200,
          );
          admissionCallbacks++;
          return testModelActionAdmitter(organizationId)(run);
        },
        runModel: async ({ signal, onDelta, onEvidence }) => {
          oldDispatches++;
          active++;
          maxActive = Math.max(maxActive, active);
          onDelta("Before expiry.");
          await Promise.race([
            sleep(400),
            new Promise<void>((resolve) => {
              if (signal.aborted) {
                resolve();
                return;
              }
              signal.addEventListener(
                "abort",
                () => {
                  resolve();
                },
                { once: true },
              );
            }),
          ]);
          active--;
          // An uncooperative transport can still invoke callbacks after abort.
          onDelta("Late reclaimed content.");
          onEvidence([{ decisionId: relatedId, paragraphId: "late" }]);
          return Result.err(
            new HandlerError({
              status: 502,
              code: "internal_error",
              message: "Expired fixture generation",
            }),
          );
        },
      });
      await waitUntil(first.deadlineAt + 30);
      const regenerated = await prepare({
        type: "regenerate",
        answerId: first.answer.id,
        body: { locale: "cs-CZ" },
      });
      const replacement = await complete(regenerated, {
        runModel: async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          active--;
          return Result.ok({
            content: "Replacement.",
            model: "fixture",
            usage: null,
          });
        },
      });
      const expired = await old;
      await waitUntil(first.deadlineAt + 120);
      expect(admissionCallbacks).toBe(1);
      expect(oldDispatches).toBe(phase === "waiting-admission" ? 0 : 1);
      expect(maxActive).toBe(1);
      expect(active).toBe(0);
      expect(expired.text).toContain('"type":"failed"');
      expect(terminalEvents(expired.text).at(0)?.errorCode).toBe("timeout");
      expect(expired.text).not.toContain('"type":"complete"');
      expect(expired.text).not.toContain("Late reclaimed content.");
      expect(expired.text).not.toContain('"paragraphId":"late"');
      expect(replacement.text).toContain('"type":"complete"');
      expect(await message(first)).toBeUndefined();
      expect(await message(regenerated)).toMatchObject({
        status: "complete",
        content: "Replacement.",
      });
    },
  );

  test.each(["before-cas", "after-cas-audit"] as const)(
    "a settlement crossing the deadline has one durable terminal event at %s",
    async (phase) => {
      setSystemTime(new Date(Date.now() - READER_ANSWER_DEADLINE_MS + 400));
      const prepared = await create();
      setSystemTime();
      const actor = scope();
      let transactionCalls = 0;
      let settledTransactions = 0;
      const audits: string[] = [];
      const delayedDb: SafeDb = async (run, retry) => {
        transactionCalls++;
        if (phase === "before-cas" && transactionCalls === 1) {
          await sleep(Math.max(0, prepared.deadlineAt + 100 - Date.now()));
        }
        const result = await actor.safeDb(run, retry);
        settledTransactions++;
        return result;
      };
      const result = await complete(prepared, {
        safeDb: delayedDb,
        recordAuditEvent: async (tx) => {
          const saved = (
            await tx
              .select({ status: legalReaderAnswerMessages.status })
              .from(legalReaderAnswerMessages)
              .where(eq(legalReaderAnswerMessages.id, prepared.messageId))
          ).at(0);
          expect(saved).toBeDefined();
          if (saved) {
            audits.push(saved.status);
          }
          if (phase === "after-cas-audit") {
            await sleep(Math.max(0, prepared.deadlineAt + 100 - Date.now()));
          }
        },
      });
      // Let the losing transaction and its callback finish after the response closes.
      await sleep(Math.max(0, prepared.deadlineAt + 200 - Date.now()));
      expect(transactionCalls).toBe(2);
      expect(settledTransactions).toBe(2);
      const expectedStatus = phase === "before-cas" ? "failed" : "complete";
      expect(audits).toEqual([expectedStatus]);
      const saved = await message(prepared);
      expect(saved?.status).toBe(expectedStatus);
      expect(saved?.errorCode).toBe(
        expectedStatus === "failed" ? "timeout" : null,
      );
      expect(saved?.invalidCitationCount).toBe(0);
      expect(await reload(prepared)).toMatchObject({
        status: expectedStatus,
        errorCode: saved?.errorCode,
        invalidCitationCount: 0,
      });
      const events = result.text
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) =>
          v.parse(
            v.object({ type: v.string(), content: v.optional(v.string()) }),
            JSON.parse(line.slice(6)),
          ),
        );
      const terminals = events.filter(
        ({ type }) => type === "complete" || type === "failed",
      );
      expect(terminals).toHaveLength(1);
      expect(terminals.at(0)).toMatchObject({
        type: expectedStatus,
        content: saved?.content,
      });
    },
  );

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
    expect(old.text).not.toContain('"type":"failed"');
    expect(old.text).not.toContain('"type":"complete"');
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
    expect(await reload(prepared)).toMatchObject({
      status: "complete",
      errorCode: null,
      invalidCitationCount: 1,
    });
    expect(await message(prepared)).toMatchObject({
      content: `Related [[${relatedId}#p-7]]. Invented .`,
      errorCode: null,
      invalidCitationCount: 1,
      citations: [{ decisionId: relatedId, paragraphId: "p-7" }],
    });
  });

  test("frozen timestamps preserve turn order in prompts and list reload across regeneration", async () => {
    const frozenAt = new Date();
    setSystemTime(frozenAt);
    const first = await prepare({
      type: "create",
      body: {
        kind: "ask",
        question: "Question one",
        decisionId,
        anchor,
        locale: "cs-CZ",
      },
    });
    type RunFrozenTurnOptions = {
      prepared: ReaderAnswerStreamOptions["prepared"];
      expectedHistory: Pick<
        ReaderAnswerStreamOptions["prepared"]["history"][number],
        "role" | "content"
      >[];
      content: string;
    };
    const runTurn = async ({
      prepared,
      expectedHistory,
      content,
    }: RunFrozenTurnOptions) => {
      expect(
        prepared.history.map(({ role, content: text }) => ({
          role,
          content: text,
        })),
      ).toEqual(expectedHistory);
      await complete(prepared, {
        runModel: async (input) => {
          expect(
            input.messages
              .slice(1)
              .map(({ role, content: text }) => ({ role, content: text })),
          ).toEqual(expectedHistory);
          return Result.ok({ content, model: "fixture", usage: null });
        },
      });
    };
    await runTurn({
      prepared: first,
      expectedHistory: [{ role: "user", content: "Question one" }],
      content: "Answer one",
    });
    const pair = await database
      .select()
      .from(legalReaderAnswerMessages)
      .where(eq(legalReaderAnswerMessages.answerId, first.answer.id));
    const firstUser = pair.find(({ role }) => role === "user");
    const firstAssistant = pair.find(({ role }) => role === "assistant");
    if (firstUser === undefined || firstAssistant === undefined) {
      throw new HandlerError({
        status: 500,
        message: "Missing frozen-clock fixture turn",
      });
    }
    // Pin UUID order opposite turn order; random UUID ordering must not decide this test.
    if (firstUser.id < firstAssistant.id) {
      const temporaryId = createSafeId<"legalReaderAnswerMessage">();
      await database.transaction(async (tx) => {
        await tx
          .update(legalReaderAnswerMessages)
          .set({ id: temporaryId })
          .where(eq(legalReaderAnswerMessages.id, firstUser.id));
        await tx
          .update(legalReaderAnswerMessages)
          .set({ id: firstUser.id })
          .where(eq(legalReaderAnswerMessages.id, firstAssistant.id));
        await tx
          .update(legalReaderAnswerMessages)
          .set({ id: firstAssistant.id })
          .where(eq(legalReaderAnswerMessages.id, temporaryId));
      });
    }
    const followUp = await prepare({
      type: "follow-up",
      answerId: first.answer.id,
      body: { question: "Question two", locale: "cs-CZ" },
    });
    const history = [
      { role: "user", content: "Question one" },
      { role: "assistant", content: "Answer one" },
      { role: "user", content: "Question two" },
    ] satisfies RunFrozenTurnOptions["expectedHistory"];
    await runTurn({
      prepared: followUp,
      expectedHistory: history,
      content: "Answer two",
    });
    const expected = [
      ...history,
      { role: "assistant", content: "Answer two" },
    ] satisfies RunFrozenTurnOptions["expectedHistory"];
    const listed = await reloadThread(followUp);
    expect(
      listed?.messages.map(({ role, content }) => ({ role, content })),
    ).toEqual(expected);
    const legacy = await database
      .select()
      .from(legalReaderAnswerMessages)
      .where(eq(legalReaderAnswerMessages.answerId, first.answer.id))
      .orderBy(
        asc(legalReaderAnswerMessages.createdAt),
        asc(legalReaderAnswerMessages.id),
      );
    expect(
      legacy.every(
        ({ createdAt }) => createdAt.getTime() === frozenAt.getTime(),
      ),
    ).toBe(true);
    expect(legacy.map(({ role, content }) => ({ role, content }))).not.toEqual(
      expected,
    );
    const oldSequence = (await message(followUp))?.sequence;
    const regenerated = await prepare({
      type: "regenerate",
      answerId: first.answer.id,
      body: { locale: "cs-CZ" },
    });
    expect(regenerated.messageId).not.toBe(followUp.messageId);
    expect((await message(regenerated))?.sequence).toBe(oldSequence);
    await runTurn({
      prepared: regenerated,
      expectedHistory: history,
      content: "Answer two regenerated",
    });
    expect(
      (await reloadThread(regenerated))?.messages.map(({ role, content }) => ({
        role,
        content,
      })),
    ).toEqual([
      ...history,
      { role: "assistant", content: "Answer two regenerated" },
    ]);
    expect(await message(followUp)).toBeUndefined();
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
