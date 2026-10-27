import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import * as v from "valibot";

import {
  READER_ANSWER_DEADLINE_MS,
  READER_ANSWER_ERROR_CODES,
} from "@stll/api-contract/reader-answers";
import { waitForExternalState } from "@stll/property-testing/external-state";

import { organization, user } from "@/api/db/auth-schema";
import {
  auditLogs,
  legalReaderAnswerMessages,
  legalReaderAnswers,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { readerAnswerDeadlineAt } from "@/api/handlers/legal-reader/answers/operation";
import type { PreparedReaderAnswer } from "@/api/handlers/legal-reader/answers/operation";
import { streamReaderAnswer } from "@/api/handlers/legal-reader/answers/stream";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createAuditRecorder,
} from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { timestampCasToken } from "@/api/lib/db/timestamp-cas";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { withTimeout } from "@/api/lib/with-timeout";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { testModelActionAdmitter } from "@/api/tests/helpers/model-dispatch-admission";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const CLAIM_REMAINING_MS = 4000;
const POLL_INTERVAL_MS = 10;
const OBSERVATION_TIMEOUT_MS = 10_000;

const streamEvents = (text: string) =>
  text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) =>
      v.parse(
        v.variant("type", [
          v.object({ type: v.literal("started") }),
          v.object({ type: v.literal("delta"), delta: v.string() }),
          v.object({ type: v.literal("complete") }),
          v.object({
            type: v.literal("failed"),
            errorCode: v.picklist(READER_ANSWER_ERROR_CODES),
            content: v.string(),
          }),
        ]),
        JSON.parse(line.slice(6)),
      ),
    );

const seedFixture = async (db: GatedTestDb) => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const answerId = createSafeId<"legalReaderAnswer">();
  const decisionId = createSafeId<"caseLawDecision">();
  const messageId = createSafeId<"legalReaderAnswerMessage">();
  const span = {
    paragraphId: "p-1",
    quote: "The holding",
    startOffset: 0,
    endOffset: 11,
  };
  await db.insert(organization).values({
    id: organizationId,
    name: "Reader deadline fixture",
    slug: organizationId,
    createdAt: new Date(),
  });
  await db.insert(user).values({
    id: userId,
    name: "Reader deadline fixture",
    email: `${userId}@example.test`,
  });
  const scopedDb = createScopedDb(
    markRlsDatabase(db),
    [],
    organizationId,
    userId,
  );
  const prepared = await scopedDb(async (tx) => {
    const answer =
      (
        await tx
          .insert(legalReaderAnswers)
          .values({
            id: answerId,
            organizationId,
            userId,
            decisionId,
            kind: "explain",
            visibility: "private",
            ...span,
          })
          .returning()
      ).at(0) ?? panic("Reader deadline answer fixture is missing");
    const history = await tx
      .insert(legalReaderAnswerMessages)
      .values({
        id: createSafeId<"legalReaderAnswerMessage">(),
        answerId,
        sequence: 1,
        role: "user",
        content: "Explain the holding",
        status: "complete",
      })
      .returning();
    // PostgreSQL owns the clock; shortening the remaining lease avoids a two-minute test.
    const assistant =
      (
        await tx
          .insert(legalReaderAnswerMessages)
          .values({
            id: messageId,
            answerId,
            sequence: 2,
            role: "assistant",
            content: "",
            status: "streaming",
            updatedAt: sql`date_trunc('milliseconds', clock_timestamp()) - (${READER_ANSWER_DEADLINE_MS - CLAIM_REMAINING_MS} * interval '1 millisecond')`,
          })
          .returning({
            updatedAt: legalReaderAnswerMessages.updatedAt,
            claimToken: timestampCasToken(legalReaderAnswerMessages.updatedAt),
          })
      ).at(0) ?? panic("Reader deadline message fixture is missing");
    return {
      answer,
      messageId,
      claimToken: assistant.claimToken,
      deadlineAt: readerAnswerDeadlineAt(assistant.updatedAt),
      history,
      decision: {
        decisionId,
        court: "Test court",
        decisionDate: "2026-01-01",
        paragraphs: [
          { paragraphId: span.paragraphId, text: "The holding follows." },
        ],
      },
      anchor: [span],
      locale: "cs-CZ",
      modelId: undefined,
    } satisfies PreparedReaderAnswer;
  });
  return {
    prepared,
    scopedDb,
    organizationId,
    userId,
    cleanUp: async () => {
      await db.delete(organization).where(eq(organization.id, organizationId));
      await db.delete(user).where(eq(user.id, userId));
    },
  };
};

type ObserveBlockedSettlementOptions = {
  scopedDb: Awaited<ReturnType<typeof seedFixture>>["scopedDb"];
  writerPid: number;
  holderPid: number;
  deadlineAt: number;
  messageId: PreparedReaderAnswer["messageId"];
};
const observeBlockedSettlement = async ({
  scopedDb,
  writerPid,
  holderPid,
  deadlineAt,
  messageId,
}: ObserveBlockedSettlementOptions) => {
  await waitForExternalState({
    description: "the reader settlement reaches its row lock before expiry",
    intervalMs: POLL_INTERVAL_MS,
    timeoutMs: OBSERVATION_TIMEOUT_MS,
    read: async () => {
      const row =
        (
          await scopedDb(
            async (tx) =>
              await tx
                .select({
                  blocked: sql<boolean>`${holderPid} = ANY(pg_blocking_pids(${writerPid}))`,
                  beforeDeadline: sql<boolean>`clock_timestamp() < to_timestamp(${deadlineAt} / 1000.0)`,
                })
                .from(legalReaderAnswerMessages)
                .where(eq(legalReaderAnswerMessages.id, messageId))
                .limit(1),
          )
        ).at(0) ?? panic("Reader deadline lock observation is missing");
      expect(row.beforeDeadline).toBe(true);
      return row.blocked;
    },
  });
};

if (!databaseUrl || !runPostgres) {
  describe.skip("reader answer settlement deadlines (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("reader answer settlement deadlines (postgres)", () => {
    test.each(["complete", "provider-error"] as const)(
      "%s started before expiry settles once as timeout after an unchanged row lock is released",
      async (providerOutcome) => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const db = openClient().db;
          const writer = openClient({
            connection: { lock_timeout: 15_000, statement_timeout: 20_000 },
          }).db;
          const holder = openClient().db;
          const fixture = await seedFixture(db);
          const { prepared, scopedDb, organizationId, userId } = fixture;
          const held = Promise.withResolvers<number>();
          const release = Promise.withResolvers<undefined>();
          let holding: Promise<void> | undefined;
          let consumed: Promise<string> | undefined;
          try {
            const scopedWriter = createScopedDb(
              markRlsDatabase(writer),
              [],
              organizationId,
              userId,
            );
            const scopedHolder = createScopedDb(
              markRlsDatabase(holder),
              [],
              organizationId,
              userId,
            );
            const writerPid =
              (
                await scopedWriter(
                  async (tx) =>
                    await tx
                      .select({ pid: sql<number>`pg_backend_pid()` })
                      .from(legalReaderAnswerMessages)
                      .where(
                        eq(legalReaderAnswerMessages.id, prepared.messageId),
                      )
                      .limit(1),
                )
              ).at(0)?.pid ?? panic("Reader settlement backend is missing");
            holding = scopedHolder(async (tx) => {
              await tx
                .select({ id: legalReaderAnswerMessages.id })
                .from(legalReaderAnswerMessages)
                .where(eq(legalReaderAnswerMessages.id, prepared.messageId))
                .for("update");
              const holderPid =
                (
                  await tx
                    .select({ pid: sql<number>`pg_backend_pid()` })
                    .from(legalReaderAnswerMessages)
                    .where(eq(legalReaderAnswerMessages.id, prepared.messageId))
                    .limit(1)
                ).at(0)?.pid ?? panic("Reader lock holder backend is missing");
              held.resolve(holderPid);
              await release.promise;
            });
            const holderPid = await withTimeout(
              async () => await held.promise,
              {
                label: "reader-answer.fixture-lock",
                timeoutMs: OBSERVATION_TIMEOUT_MS,
              },
            );
            expect(holderPid).not.toBe(writerPid);
            let providerCalls = 0;
            const response = streamReaderAnswer({
              organizationId,
              userId,
              prepared,
              safeDb: createSafeDb(
                markRlsDatabase(writer),
                [],
                organizationId,
                userId,
              ),
              recordAuditEvent: createAuditRecorder({
                organizationId,
                userId,
                workspaceId: null,
                request: new Request("https://example.test/reader-deadline"),
                server: null,
              }),
              orgAIConfig: null,
              managedAIResidency: "eu",
              requestSignal: new AbortController().signal,
              admitModelAction: testModelActionAdmitter(organizationId),
              runModel: async ({ onDelta }) => {
                providerCalls++;
                onDelta("Partial explanation");
                if (providerOutcome === "provider-error") {
                  return Result.err(
                    new HandlerError({
                      status: 502,
                      code: "provider-error",
                      message: "Fixture provider failed before expiry",
                    }),
                  );
                }
                return Result.ok({
                  content: "Final explanation",
                  model: "fixture-model",
                  usage: null,
                });
              },
            });
            consumed = response.text();
            await observeBlockedSettlement({
              scopedDb,
              writerPid,
              holderPid,
              deadlineAt: prepared.deadlineAt,
              messageId: prepared.messageId,
            });
            expect(providerCalls).toBe(1);
            // Release is tied to PostgreSQL's execution clock, not JS timers or transaction now().
            await scopedDb(
              async (tx) =>
                await tx.execute(sql`SELECT pg_sleep(GREATEST(0,
              extract(epoch FROM (to_timestamp(${prepared.deadlineAt} / 1000.0) - clock_timestamp()))
            ) + 0.05)`),
            );
            const locked =
              (
                await scopedDb(
                  async (tx) =>
                    await tx
                      .select({
                        status: legalReaderAnswerMessages.status,
                        content: legalReaderAnswerMessages.content,
                        claimToken: timestampCasToken(
                          legalReaderAnswerMessages.updatedAt,
                        ),
                        expired: sql<boolean>`clock_timestamp() >= to_timestamp(${prepared.deadlineAt} / 1000.0)`,
                      })
                      .from(legalReaderAnswerMessages)
                      .where(
                        eq(legalReaderAnswerMessages.id, prepared.messageId),
                      ),
                )
              ).at(0) ?? panic("Locked reader message is missing");
            expect(locked).toEqual({
              status: "streaming",
              content: "",
              claimToken: prepared.claimToken,
              expired: true,
            });
            release.resolve(undefined);
            await holding;
            const events = streamEvents(await consumed);
            expect(
              events.filter(({ type }) => type === "complete"),
            ).toHaveLength(0);
            expect(events.filter(({ type }) => type === "failed")).toEqual([
              {
                type: "failed",
                errorCode: "timeout",
                content: "Partial explanation",
              },
            ]);
            const saved = await scopedDb(
              async (tx) =>
                await tx
                  .select({
                    status: legalReaderAnswerMessages.status,
                    errorCode: legalReaderAnswerMessages.errorCode,
                    content: legalReaderAnswerMessages.content,
                  })
                  .from(legalReaderAnswerMessages)
                  .where(eq(legalReaderAnswerMessages.id, prepared.messageId)),
            );
            expect(saved).toEqual([
              {
                status: "failed",
                errorCode: "timeout",
                content: "Partial explanation",
              },
            ]);
            const audits = await scopedDb(
              async (tx) =>
                await tx
                  .select({
                    action: auditLogs.action,
                    resourceType: auditLogs.resourceType,
                  })
                  .from(auditLogs)
                  .where(
                    and(
                      eq(auditLogs.organizationId, organizationId),
                      eq(auditLogs.resourceId, prepared.answer.id),
                    ),
                  ),
            );
            expect(audits).toEqual([
              {
                action: AUDIT_ACTION.UPDATE,
                resourceType: AUDIT_RESOURCE_TYPE.CASE_LAW_READER_ANSWER,
              },
            ]);
          } finally {
            release.resolve(undefined);
            try {
              await holding;
              await consumed;
            } finally {
              await fixture.cleanUp();
            }
          }
        });
      },
      30_000,
    );
  });
}
