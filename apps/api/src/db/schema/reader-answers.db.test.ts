import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { organization, user } from "@/api/db/auth-schema";
import { legalReaderAnswers, legalReaderAnswerMessages } from "@/api/db/schema";
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
      INSERT INTO legal_reader_answer_messages (id, answer_id, role, content, status)
      VALUES (${Bun.randomUUIDv7()}, ${answer.id}, 'assistant', '', 'unknown')
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
});
