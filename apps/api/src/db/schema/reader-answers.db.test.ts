import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  expectTypeOf,
  test,
} from "bun:test";
import { eq, sql } from "drizzle-orm";

import { ACTION_ADMISSION_CODES } from "@stll/api-contract/action-admission";
import type { ReaderAnswerErrorCode } from "@stll/api-contract/reader-answers";
import { READER_ANSWER_ERROR_CODES } from "@stll/api-contract/reader-answers";

import { organization, user } from "@/api/db/auth-schema";
import { legalReaderAnswerMessages, legalReaderAnswers } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import {
  getTestDb,
  releaseTestDb,
  type TestDatabase,
} from "@/api/tests/security/test-utils";

const organizationId = mintAuthProviderId<"organization">();
const userId = mintAuthProviderId<"user">();
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
    slug: `reader-answers-${organizationId}`,
    createdAt: new Date(),
  });
});

afterAll(releaseTestDb);

const answerRow = () => ({
  id: createSafeId<"legalReaderAnswer">(),
  organizationId,
  userId,
  decisionId: createSafeId<"caseLawDecision">(),
  kind: "explain" as const,
  paragraphId: "p-1",
  quote: "selected passage",
  startOffset: 0,
  endOffset: 16,
});

const causeText = (error: unknown): string => {
  const messages: string[] = [];
  let current = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join(" | ");
};

describe("reader answer storage", () => {
  test("deleting a thread removes its messages", async () => {
    const answer = answerRow();
    await database.insert(legalReaderAnswers).values(answer);
    await database.insert(legalReaderAnswerMessages).values({
      answerId: answer.id,
      sequence: 1,
      role: "assistant",
      content: "An explanation",
      status: "complete",
      citations: [{ decisionId: answer.decisionId, paragraphId: "p-1" }],
      usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
    });
    const before = await database
      .select()
      .from(legalReaderAnswerMessages)
      .where(eq(legalReaderAnswerMessages.answerId, answer.id));
    expect(before).toHaveLength(1);
    expect(before.at(0)?.citations).toEqual([
      { decisionId: answer.decisionId, paragraphId: "p-1" },
    ]);
    await database
      .delete(legalReaderAnswers)
      .where(eq(legalReaderAnswers.id, answer.id));
    const after = await database
      .select()
      .from(legalReaderAnswerMessages)
      .where(eq(legalReaderAnswerMessages.answerId, answer.id));
    expect(after).toHaveLength(0);
  });

  test("refuses invalid paragraph offset spans", async () => {
    const result = await Result.tryPromise(
      async () =>
        await database
          .insert(legalReaderAnswers)
          .values({ ...answerRow(), endOffset: 0 }),
    );
    expect(Result.isError(result)).toBe(true);
    expect(causeText(Result.isError(result) ? result.error : null)).toContain(
      "legal_reader_answers_span_shape",
    );
  });

  test("refuses an unknown message lifecycle state", async () => {
    const answer = answerRow();
    await database.insert(legalReaderAnswers).values(answer);
    const result = await Result.tryPromise(
      async () =>
        await database.execute(sql`
      INSERT INTO legal_reader_answer_messages (id, answer_id, sequence, role, content, status)
      VALUES (${Bun.randomUUIDv7()}, ${answer.id}, 1, 'assistant', '', 'unknown')
    `),
    );
    expect(Result.isError(result)).toBe(true);
    expect(causeText(Result.isError(result) ? result.error : null)).toContain(
      "legal_reader_answer_messages_status_values",
    );
  });

  test("enables and forces row security for both relations", async () => {
    const rows = await database.execute<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(sql`
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE oid IN ('legal_reader_answers'::regclass, 'legal_reader_answer_messages'::regclass)
      ORDER BY relname
    `);
    expect(rows.rows).toEqual([
      {
        relname: "legal_reader_answer_messages",
        relrowsecurity: true,
        relforcerowsecurity: true,
      },
      {
        relname: "legal_reader_answers",
        relrowsecurity: true,
        relforcerowsecurity: true,
      },
    ]);
  });

  test("stores every error code and defaults absent diagnostics", async () => {
    const answer = answerRow();
    await database.insert(legalReaderAnswers).values(answer);
    const defaults = await database
      .insert(legalReaderAnswerMessages)
      .values({
        answerId: answer.id,
        sequence: 1,
        role: "assistant",
        content: "",
        status: "failed",
      })
      .returning();
    expect(defaults.at(0)?.errorCode).toBeNull();
    expect(defaults.at(0)?.invalidCitationCount).toBe(0);
    const diagnostics = await database
      .insert(legalReaderAnswerMessages)
      .values(
        READER_ANSWER_ERROR_CODES.map((errorCode, index) => ({
          answerId: answer.id,
          sequence: index + 2,
          role: "assistant" as const,
          content: "",
          status: "failed" as const,
          errorCode,
          invalidCitationCount: 2,
        })),
      )
      .returning();
    expect(new Set(diagnostics.map((message) => message.errorCode))).toEqual(
      new Set(READER_ANSWER_ERROR_CODES),
    );
    expect(
      diagnostics.every((message) => message.invalidCitationCount === 2),
    ).toBe(true);
  });

  test("legacy diagnostics read as current codes while writes accept only the current contract", async () => {
    expectTypeOf<
      (typeof legalReaderAnswerMessages.$inferInsert)["errorCode"]
    >().toEqualTypeOf<ReaderAnswerErrorCode | null | undefined>();
    expectTypeOf<"action_admission_unavailable">().not.toExtend<
      NonNullable<(typeof legalReaderAnswerMessages.$inferInsert)["errorCode"]>
    >();
    const answer = answerRow();
    await database.insert(legalReaderAnswers).values(answer);
    const id = createSafeId<"legalReaderAnswerMessage">();
    await database.execute(sql`
      INSERT INTO legal_reader_answer_messages (id, answer_id, sequence, role, content, status, error_code)
      VALUES (${id}, ${answer.id}, 1, 'assistant', 'Retained answer', 'failed', 'action_admission_unavailable')
    `);
    const [message] = await database
      .select()
      .from(legalReaderAnswerMessages)
      .where(eq(legalReaderAnswerMessages.id, id));
    expect(message?.errorCode).toBe(ACTION_ADMISSION_CODES.storeUnavailable);
    expect(message?.content).toBe("Retained answer");
    await database.execute(
      sql`UPDATE legal_reader_answer_messages SET content = 'Updated answer' WHERE id = ${id}`,
    );
    const stored = await database.execute(
      sql`SELECT error_code, content FROM legal_reader_answer_messages WHERE id = ${id}`,
    );
    expect(stored.rows).toEqual([
      { error_code: "action_admission_unavailable", content: "Updated answer" },
    ]);
  });

  test("refuses unknown error codes and negative citation counts", async () => {
    const answer = answerRow();
    await database.insert(legalReaderAnswers).values(answer);
    const invalidCode = await Result.tryPromise(
      async () =>
        await database.execute(sql`
      INSERT INTO legal_reader_answer_messages (id, answer_id, sequence, role, content, status, error_code)
      VALUES (${Bun.randomUUIDv7()}, ${answer.id}, 1, 'assistant', '', 'failed', 'unknown')
    `),
    );
    expect(invalidCode.isErr()).toBe(true);
    expect(causeText(invalidCode.isErr() ? invalidCode.error : null)).toContain(
      "legal_reader_answer_messages_error_code_values",
    );
    const invalidCount = await Result.tryPromise(
      async () =>
        await database.execute(sql`
      INSERT INTO legal_reader_answer_messages (id, answer_id, sequence, role, content, status, invalid_citation_count)
      VALUES (${Bun.randomUUIDv7()}, ${answer.id}, 1, 'assistant', '', 'complete', -1)
    `),
    );
    expect(invalidCount.isErr()).toBe(true);
    expect(
      causeText(invalidCount.isErr() ? invalidCount.error : null),
    ).toContain(
      "legal_reader_answer_messages_invalid_citation_count_nonnegative",
    );
  });

  test("requires a positive unique message position within each thread", async () => {
    const testDatabase = database;
    const answer = answerRow();
    const another = answerRow();
    await testDatabase.insert(legalReaderAnswers).values([answer, another]);
    const message = {
      answerId: answer.id,
      role: "assistant" as const,
      content: "An explanation",
      status: "complete" as const,
    };
    await testDatabase
      .insert(legalReaderAnswerMessages)
      .values({ ...message, sequence: 1 });
    for (const sequence of [0, -1]) {
      const rejected = await Result.tryPromise(
        async () =>
          await testDatabase
            .insert(legalReaderAnswerMessages)
            .values({ ...message, sequence }),
      );
      expect(rejected.isErr()).toBe(true);
      expect(causeText(rejected.isErr() ? rejected.error : null)).toContain(
        "legal_reader_answer_messages_sequence_positive",
      );
    }
    const duplicate = await Result.tryPromise(
      async () =>
        await testDatabase
          .insert(legalReaderAnswerMessages)
          .values({ ...message, sequence: 1 }),
    );
    expect(duplicate.isErr()).toBe(true);
    expect(causeText(duplicate.isErr() ? duplicate.error : null)).toContain(
      "legal_reader_answer_messages_answer_sequence_idx",
    );
    const otherThread = await testDatabase
      .insert(legalReaderAnswerMessages)
      .values({
        ...message,
        answerId: another.id,
        sequence: 1,
      })
      .returning();
    expect(otherThread.at(0)?.sequence).toBe(1);
  });
});
