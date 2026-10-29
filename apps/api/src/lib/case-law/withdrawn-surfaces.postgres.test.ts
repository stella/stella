import { EventType } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { panic, Result } from "better-result";
import { beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import JSZip from "jszip";

import { compareCodeUnit } from "@stll/collation";

import { ACCOUNT_EXPORT_PROJECTIONS } from "@/api/account-export-projections";
import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawDecisions,
  caseLawIndexJobs,
  caseLawMatterLinks,
  caseLawResearchAnswers,
  caseLawResearchColumns,
  caseLawSources,
  CHAT_RUN_REFERENCE_STATE_MAX_BYTES,
  chatMessageRevisions,
  chatMessages,
  chatMessageSearchDocuments,
  chatRunLogs,
  chatThreadCompactions,
  chatThreads,
  chatThreadSearchDocuments,
  chatThreadSearchPreviewPassages,
  chatTurns,
  legalReaderAnnotations,
  legalReaderAnswerMessages,
  legalReaderAnswers,
  workspaces,
} from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { redactCaseLawDecision } from "@/api/handlers/case-law/erasure";
import { listMatterLinksHandler } from "@/api/handlers/case-law/matter-links/list";
import { readResearchAnswers } from "@/api/handlers/case-law/research/answers-lookup";
import { normalizePersistedChatMessageContent } from "@/api/handlers/chat/chat-message-parts";
import { readChatRevisionContextChanges } from "@/api/handlers/chat/chat-revision-context";
import { createChatExportDocx } from "@/api/handlers/chat/export/create-chat-export-docx";
import { assembleMessageMarkdown } from "@/api/handlers/chat/export/export-shared";
import { loadWindowedThreadMessages } from "@/api/handlers/chat/history-window";
import { loadChatMessagePage } from "@/api/handlers/chat/message-page";
import { readChatMessageRevisionsOnTx } from "@/api/handlers/chat/messages/revisions/list";
import { prepareSpanRewrite } from "@/api/handlers/chat/messages/revisions/prepare-span-rewrite";
import { readEditableMessageOnTx } from "@/api/handlers/chat/messages/revisions/read-message";
import { readLatestChatCompaction } from "@/api/handlers/chat/persistent-compaction";
import { loadRecapMessageWindow } from "@/api/handlers/chat/thread-recap-window";
import { readThreadTitleInput } from "@/api/handlers/chat/thread-title-input";
import { listReaderAnswersHandler } from "@/api/handlers/legal-reader/answers/list";
import { prepareReaderAnswer } from "@/api/handlers/legal-reader/answers/operation";
import { exportAccountRows } from "@/api/lib/account-export/pages";
import { createSafeId } from "@/api/lib/branded-types";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { decisionReferencesIn } from "@/api/lib/case-law/withdrawn-copy-projection";
import { readChatExportSource } from "@/api/lib/chat/export-source";
import { proveTextOnlyPersistedChatMessageContent } from "@/api/lib/chat/persisted-message-content";
import {
  createChatRunLog,
  createChatRunLogReplay,
  MAX_RUN_BYTES,
  READ_PAGE_SIZE,
} from "@/api/lib/chat/run-log";
import { createStreamMessageCapture } from "@/api/lib/chat/stream-message-capture";
import { readChatCopyProjection } from "@/api/lib/chat/withdrawn-copies";
import { runWithQueryCounter } from "@/api/lib/db-query-counter";
import { markdownToStellaDocument } from "@/api/lib/docx-authoring/from-markdown";
import { deleteCorpusDocument } from "@/api/lib/legal-search/corpus-storage";
import { listReaderAnnotationsHandler } from "@/api/lib/legal-search/reader-annotations/list";
import {
  openRequestContext,
  runWithRequestIdScope,
} from "@/api/lib/observability/request-context";
import { CHAT_SEARCH_DISPLAY_METADATA_GENERATION } from "@/api/lib/search/chat-search-generation";
import { chatSearchVectorSql } from "@/api/lib/search/chat-search-text";
import { upsertChatThreadSearchDocument } from "@/api/lib/search/index-chat";
import { searchGlobal } from "@/api/lib/search/index-global";
import { readSearchPreview } from "@/api/lib/search/preview";
import { buildSearchTsQuery } from "@/api/lib/search/query";
import {
  openGatedTestDatabase,
  withGatedTestClients,
} from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { buildWireSnapshot } from "@/api/tests/helpers/chat-fixtures";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";

import type { DecisionCopyStore } from "./withdrawn-copy-registry";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const secret = "Rozhodnutí Žofie Dvořákové";
const own = "My own note and question";
const marker = "Staženo vydavatelem";
const request = async <T>(read: () => Promise<T>) =>
  await runWithRequestIdScope(async () => {
    openRequestContext();
    return await read();
  }, "cs");

describe.skipIf(!enabled)("withdrawn copy read surfaces (postgres)", () => {
  const { db, cleanUp } = openGatedTestDatabase(
    process.env["DATABASE_URL"] ??
      panic("Postgres fixture requires DATABASE_URL"),
  );
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const workspaceId = createSafeId<"workspace">();
  const sourceId = createSafeId<"caseLawSource">();
  const decisionId = createSafeId<"caseLawDecision">();
  const activeId = createSafeId<"caseLawDecision">();
  const seededDecisionIds = [decisionId, activeId];
  const threadId = createSafeId<"chatThread">();
  const activeThreadId = createSafeId<"chatThread">();
  const seededThreads = [threadId, activeThreadId];
  const messageId = createSafeId<"chatMessage">();
  const userMessageId = createSafeId<"chatMessage">();
  const answerId = createSafeId<"legalReaderAnswer">();
  const columnId = createSafeId<"caseLawResearchColumn">();
  const turnId = createSafeId<"chatTurn">();
  const runId = Bun.randomUUIDv7();
  const executionId = Bun.randomUUIDv7();
  const scopedDb = createScopedDb(
    markRlsDatabase(db),
    [workspaceId],
    organizationId,
    userId,
  );
  const safeDb = toSafeDbMock(scopedDb);
  const content = proveTextOnlyPersistedChatMessageContent({
    version: 3,
    data: [
      {
        type: "text",
        content: `${secret} [decision](#stella-decision=${decisionId})`,
      },
    ],
  });
  const ownContent = proveTextOnlyPersistedChatMessageContent({
    version: 3,
    data: [{ type: "text", content: own }],
  });
  const summary = {
    version: 1 as const,
    goal: secret,
    blocked: [],
    constraints: [],
    criticalContext: [],
    done: [],
    inProgress: [],
    keyDecisions: [],
    modifiedFiles: [],
    nextSteps: [],
    readFiles: [],
  };
  const scope = { organizationId, userId, safeDb };

  beforeAll(async () => {
    await db
      .insert(user)
      .values({ id: userId, name: "Reader", email: `${userId}@example.test` });
    await db.insert(organization).values({
      id: organizationId,
      name: "Reader",
      slug: organizationId,
      createdAt: new Date(),
    });
    await db.insert(member).values({
      id: mintAuthProviderIdValue(),
      organizationId,
      userId,
      role: "owner",
      createdAt: new Date(),
    });
    await db.insert(workspaces).values({
      id: workspaceId,
      organizationId,
      name: "Reader matter",
      reference: workspaceId,
    });
    await db.insert(caseLawSources).values({
      id: sourceId,
      adapterKey: sourceId,
      name: "Fixture",
      enabled: false,
    });
    await db.insert(caseLawDecisions).values(
      [decisionId, activeId].map((id) => ({
        id,
        sourceId,
        sourceDocumentId: id,
        caseNumber: secret,
        country: "POL",
        court: "Fixture",
        language: "pl",
        fulltext: secret,
        contentHash: "fixture",
      })),
    );
    await scopedDb(async (tx) => {
      await tx.insert(legalReaderAnnotations).values({
        id: createSafeId<"legalReaderAnnotation">(),
        organizationId,
        userId,
        targetType: "decision",
        targetId: decisionId,
        kind: "comment",
        visibility: "private",
        blockAnchorId: "p1",
        startOffset: 0,
        endOffset: secret.length,
        quote: secret,
        body: own,
      });
      await tx.insert(legalReaderAnswers).values({
        id: answerId,
        organizationId,
        userId,
        decisionId,
        kind: "explain",
        paragraphId: "p1",
        startOffset: 0,
        endOffset: secret.length,
        quote: secret,
        continuationSpans: [
          {
            paragraphId: "p2",
            startOffset: 0,
            endOffset: secret.length,
            quote: secret,
          },
        ],
      });
      await tx.insert(legalReaderAnswerMessages).values([
        {
          id: createSafeId<"legalReaderAnswerMessage">(),
          answerId,
          sequence: 1,
          role: "user",
          content: own,
          status: "complete",
        },
        {
          id: createSafeId<"legalReaderAnswerMessage">(),
          answerId,
          sequence: 2,
          role: "assistant",
          content: secret,
          status: "complete",
        },
      ]);
      await tx.insert(caseLawResearchColumns).values({
        id: columnId,
        organizationId,
        position: 0,
        question: "Question",
        content: { version: 1, type: "text" },
        tool: { version: 1, task: "short-text" },
      });
      await tx.insert(caseLawResearchAnswers).values({
        columnId,
        organizationId,
        decisionId,
        state: "answered",
        answer: { version: 1, type: "text", value: secret },
      });
      await tx.insert(caseLawMatterLinks).values({
        id: createSafeId<"caseLawMatterLink">(),
        workspaceId,
        decisionId,
        linkedBy: userId,
        note: own,
      });
      await tx.insert(chatThreads).values({
        id: threadId,
        organizationId,
        userId,
        workspaceId,
        title: secret,
        titleSource: "ai",
        subjectDecisionId: decisionId,
        recapText: secret,
      });
      await tx.insert(chatThreads).values({
        id: activeThreadId,
        organizationId,
        userId,
        workspaceId,
        title: secret,
        titleSource: "ai",
        subjectDecisionId: activeId,
      });
      await tx.insert(chatMessages).values({
        id: createSafeId<"chatMessage">(),
        threadId: activeThreadId,
        userId,
        workspaceId,
        role: "assistant",
        content: proveTextOnlyPersistedChatMessageContent({
          version: 3,
          data: [{ type: "text", content: secret }],
        }),
      });
      await tx.insert(chatMessages).values([
        {
          id: userMessageId,
          threadId,
          userId,
          workspaceId,
          role: "user",
          content: ownContent,
        },
        {
          id: messageId,
          threadId,
          userId,
          workspaceId,
          role: "assistant",
          content,
          revision: 1,
        },
      ]);
      await tx.insert(chatMessageRevisions).values({
        id: createSafeId<"chatMessageRevision">(),
        messageId,
        threadId,
        workspaceId,
        revision: 0,
        content,
        edit: {
          type: "ai_span",
          start: 0,
          end: 1,
          instruction: own,
          model: "fixture",
          keySource: "instance",
        },
        createdBy: userId,
      });
      await tx.insert(chatThreadCompactions).values({
        id: createSafeId<"chatThreadCompaction">(),
        threadId,
        summary,
        summaryMarkdown: secret,
        firstSummarizedMessageId: userMessageId,
        lastSummarizedMessageId: userMessageId,
        firstKeptMessageId: messageId,
        summarizedMessageCount: 1,
        totalTokens: 1,
        preservedTokens: 1,
        promptVersion: 1,
      });
      await tx.insert(chatTurns).values({
        id: turnId,
        organizationId,
        userId,
        workspaceId,
        threadId,
        userMessageId,
        runId,
        executionId,
        status: "running",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      });
    });
    await scopedDb(async (tx) => {
      await upsertChatThreadSearchDocument(threadId, tx);
    });
    await db.insert(chatThreadSearchPreviewPassages).values({
      threadId,
      generation: CHAT_SEARCH_DISPLAY_METADATA_GENERATION,
      ordinal: 0,
      content: secret,
      tsv: sql`to_tsvector('simple', ${secret})`,
    });
    const before = (
      await request(async () =>
        loadChatMessagePage({ safeDb, threadId, userId }),
      )
    ).unwrap();
    expect(JSON.stringify(before)).toContain(secret);
    const withdrawal = await redactCaseLawDecision({
      decisionId,
      scopedDb: asTestRaw<ScopedDb>(
        async <T>(read: (tx: Transaction) => Promise<T>) =>
          await db.transaction(async (tx) => await read(asTestRaw(tx))),
      ),
      sweepRaw: async () => ({ type: "swept", legacy: "none" }),
      deleteCorpus: async (keys, options) =>
        await deleteCorpusDocument(keys, {
          ...options,
          deleteObject: async () => undefined,
        }),
    });
    expect(withdrawal.isOk()).toBe(true);
  });
  cleanUp(async () => {
    await scopedDb(async (tx) => {
      await tx
        .delete(chatThreads)
        .where(inArray(chatThreads.id, seededThreads));
      await tx
        .delete(legalReaderAnswers)
        .where(eq(legalReaderAnswers.id, answerId));
      await tx
        .delete(legalReaderAnnotations)
        .where(eq(legalReaderAnnotations.organizationId, organizationId));
      await tx
        .delete(caseLawResearchColumns)
        .where(eq(caseLawResearchColumns.id, columnId));
      await tx
        .delete(caseLawMatterLinks)
        .where(eq(caseLawMatterLinks.workspaceId, workspaceId));
    });
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await db
      .delete(caseLawIndexJobs)
      .where(inArray(caseLawIndexJobs.decisionId, seededDecisionIds));
    await db
      .delete(caseLawDecisions)
      .where(inArray(caseLawDecisions.id, seededDecisionIds));
    await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
    await db.delete(organization).where(eq(organization.id, organizationId));
    await db.delete(user).where(eq(user.id, userId));
  });

  const surfaceCases = {
    "reader lists and matter links retain authored text and use only a translated marker":
      async () => {
        const annotations = (
          await request(async () =>
            Result.gen(() =>
              listReaderAnnotationsHandler({
                ...scope,
                query: { targetType: "decision", targetId: decisionId },
              }),
            ),
          )
        ).unwrap();
        const answers = (
          await request(async () =>
            Result.gen(() =>
              listReaderAnswersHandler({ ...scope, query: { decisionId } }),
            ),
          )
        ).unwrap();
        const research = (
          await request(async () =>
            readResearchAnswers({
              safeDb,
              organizationId,
              decisionIds: [decisionId],
            }),
          )
        ).unwrap();
        const links = await request(async () =>
          listMatterLinksHandler({
            scopedDb,
            workspaceId,
            caseLawDb: caseLawPublicReadDb,
          }),
        );
        for (const output of [annotations, answers, research, links]) {
          expect(JSON.stringify(output)).toContain(marker);
          expect(JSON.stringify(output)).not.toContain(secret);
        }
        expect(JSON.stringify([annotations, answers, links])).toContain(own);
        expect(research.at(0)).toMatchObject({
          state: "withdrawn",
          answer: null,
          run: null,
        });
        expect(links.links.at(0)).toMatchObject({
          note: own,
          decision: { status: "withdrawn", marker },
        });
        return {
          legalReaderAnnotations: annotations,
          legalReaderAnswers: answers,
          legalReaderAnswerMessages: answers.items.flatMap(
            (row) => row.messages,
          ),
          caseLawResearchAnswers: research,
          caseLawMatterLinks: links,
        };
      },

    "transcript, revision, compaction and AI context readers share one status lookup":
      async () =>
        await request(
          async () =>
            await runWithQueryCounter(
              async (counter) => {
                const page = (
                  await loadChatMessagePage({ safeDb, threadId, userId })
                ).unwrap();
                const history = (
                  await loadWindowedThreadMessages({ safeDb, threadId })
                ).unwrap();
                const changes = (
                  await readChatRevisionContextChanges({
                    safeDb,
                    threadId,
                    messages: [{ id: messageId, role: "assistant" }],
                  })
                ).unwrap();
                const checkpoint = (
                  await readLatestChatCompaction({ safeDb, threadId })
                ).unwrap();
                const recap = (
                  await loadRecapMessageWindow({ safeDb, threadId, userId })
                ).unwrap();
                const revisions = (
                  await safeDb(
                    async (tx) =>
                      await readChatMessageRevisionsOnTx({
                        tx,
                        threadId,
                        messageId,
                        userId,
                        organizationId,
                        limit: 20,
                        getWorkspaceAccess: async (id) => ({
                          id,
                          status: "active",
                        }),
                      }),
                  )
                ).unwrap();
                for (const output of [
                  page,
                  history,
                  changes,
                  checkpoint,
                  recap,
                  revisions,
                ]) {
                  expect(JSON.stringify(output)).toContain(marker);
                  expect(JSON.stringify(output)).not.toContain(secret);
                }
                expect(JSON.stringify(page)).toContain(own);
                expect(JSON.stringify(revisions)).toContain(own);
                const editable = (
                  await safeDb(async (tx) => {
                    const loaded = await readEditableMessageOnTx({
                      tx,
                      threadId,
                      messageId,
                      organizationId,
                      userId,
                      getWorkspaceAccess: async (id) => ({
                        id,
                        status: "active",
                      }),
                    });
                    if (loaded === null) {
                      return panic("Rewrite fixture must resolve");
                    }
                    const { projection } = await readChatCopyProjection({
                      tx,
                      threadIds: [threadId],
                      values: loaded,
                    });
                    return prepareSpanRewrite({
                      loaded,
                      projection,
                      body: {
                        baseRevision: 1,
                        start: 0,
                        end: 1,
                        selectedTextHash: "fixture",
                        instruction: own,
                      },
                    });
                  })
                ).unwrap();
                expect(editable.isErr()).toBe(true);
                if (editable.isErr()) {
                  expect(editable.error.message).toBe(marker);
                }
                const lookups = [...counter.fingerprints]
                  .filter(([key]) =>
                    key.includes('from "case_law_withdrawal_status"'),
                  )
                  .reduce((total, [, count]) => total + count, 0);
                expect(lookups).toBe(1);
                return {
                  chatMessages: page,
                  chatMessageRevisions: revisions,
                  chatThreadCompactions: checkpoint,
                  chatThreads: recap,
                };
              },
              { detectRepeatedQueries: true },
            ),
        ),

    "document and account export inputs contain the marker and preserve authored text":
      async () => {
        const source = (
          await request(async () =>
            readChatExportSource({ safeDb, threadId, messageId, userId }),
          )
        ).unwrap();
        const message =
          source?.messages.at(0) ?? panic("Export fixture must resolve");
        const markdown = assembleMessageMarkdown(
          normalizePersistedChatMessageContent(message.content).parts,
        );
        expect(markdown).toBe(marker);
        const docx = await JSZip.loadAsync(
          await createChatExportDocx(markdownToStellaDocument(markdown)),
        );
        const documentXml = await docx
          .file("word/document.xml")
          ?.async("string");
        expect(documentXml).toContain(marker);
        expect(documentXml).not.toContain(secret);
        expect(source?.title).toBe(marker);
        const title = (
          await request(
            async () =>
              await readThreadTitleInput({
                safeDb,
                threadId,
                userId,
                messages: [
                  { role: "user", parts: [{ type: "text", content: own }] },
                  {
                    role: "assistant",
                    parts: [{ type: "text", content: secret }],
                  },
                ],
              }),
          )
        ).unwrap();
        expect(title).toEqual({ type: "withdrawn", marker });

        for (const table of [
          "legal_reader_annotations",
          "legal_reader_answers",
        ] as const) {
          const rows = await request(async () => {
            const result: unknown[] = [];
            for await (const row of exportAccountRows({
              db,
              projections: ACCOUNT_EXPORT_PROJECTIONS,
              scopedDatabase: markRlsDatabase(db),
              userId,
              table,
              signal: new AbortController().signal,
            })) {
              result.push(row);
            }
            return result;
          });
          expect(JSON.stringify(rows)).toContain(marker);
          expect(JSON.stringify(rows)).toContain(own);
          expect(JSON.stringify(rows)).not.toContain(secret);
        }
        const stored = await scopedDb((tx) =>
          tx
            .select({ content: chatMessages.content })
            .from(chatMessages)
            .where(eq(chatMessages.id, messageId))
            .limit(1),
        );
        expect(JSON.stringify(stored)).toContain(secret);
        return { chatMessages: source };
      },

    "tenant search matches and ranks admitted text while projected previews retain the marker":
      async () => {
        const query = {
          organizationId,
          userId,
          accessibleWorkspaceIds: [workspaceId],
          selectedWorkspaceIds: [],
          types: ["chat" as const],
          editedByUserIds: [],
          mimeTypes: [],
          limit: 10,
        };
        const hidden = await request(async () =>
          searchGlobal({ ...query, query: "Dvořákové" }, { scopedDb }),
        );
        expect(hidden.hits).toEqual([]);
        expect(hidden.totalCount).toBe(1);
        expect(hidden.facets.type).toContainEqual({ value: "chat", count: 1 });
        const authored = await request(async () =>
          searchGlobal({ ...query, query: "question" }, { scopedDb }),
        );
        expect(authored.hits).toHaveLength(1);
        expect(authored.hits.at(0)?.title).toBe(marker);
        expect(JSON.stringify(authored)).not.toContain(secret);
        const preview = await request(async () =>
          readSearchPreview(
            {
              organizationId,
              userId,
              accessibleWorkspaceIds: [workspaceId],
              type: "chat",
              resultId: threadId,
              query: "Dvořákové",
            },
            scopedDb,
          ),
        );
        expect(JSON.stringify(preview)).toContain(marker);
        expect(JSON.stringify(preview)).not.toContain(secret);
        const stored = await scopedDb(async (tx) => ({
          messages: await tx
            .select()
            .from(chatMessageSearchDocuments)
            .where(eq(chatMessageSearchDocuments.threadId, threadId))
            .limit(10),
          threads: await tx
            .select()
            .from(chatThreadSearchDocuments)
            .where(eq(chatThreadSearchDocuments.threadId, threadId))
            .limit(1),
          passages: await db
            .select()
            .from(chatThreadSearchPreviewPassages)
            .where(eq(chatThreadSearchPreviewPassages.threadId, threadId))
            .limit(10),
        }));
        for (const source of Object.values(stored)) {
          expect(JSON.stringify(source)).toContain(secret);
        }
        return {
          chatMessageSearchDocuments: authored,
          chatThreadSearchDocuments: authored,
          chatThreadSearchPreviewPassages: preview,
        };
      },

    "durable stream replay keeps offsets and SDK completion while replacing derived payloads":
      async () => {
        const log = createChatRunLog({
          db: scopedDb,
          organizationId,
          runId,
          execution: { id: turnId, executionId },
        });
        await log.append([
          { type: EventType.RUN_STARTED, runId, threadId },
          { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" },
          { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: secret },
          { type: EventType.TEXT_MESSAGE_END, messageId },
          { type: EventType.RUN_FINISHED, runId, threadId },
        ]);
        const entries = await request(async () => log.snapshot());
        expect(entries.map(({ offset }) => offset)).toEqual([
          "1",
          "2",
          "3",
          "4",
          "5",
        ]);
        expect(JSON.stringify(entries)).toContain(marker);
        expect(JSON.stringify(entries)).not.toContain(secret);
        const { processor } = createStreamMessageCapture({
          initialMessages: [],
          capture: (message) => message,
        });
        for (const { chunk } of entries) {
          processor.processChunk(chunk);
        }
        expect(JSON.stringify(processor.getMessages())).toContain(marker);
        expect(JSON.stringify(processor.getMessages())).not.toContain(secret);
        await log.append([
          {
            type: EventType.TEXT_MESSAGE_START,
            messageId: userMessageId,
            role: "user",
          },
          {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: userMessageId,
            delta: own,
          },
          { type: EventType.TEXT_MESSAGE_END, messageId: userMessageId },
        ]);
        const suffix = await request(async () => {
          const reconnected = createChatRunLog({
            db: scopedDb,
            organizationId,
            runId,
            execution: { id: turnId, executionId },
          });
          const received = [];
          for await (const entry of reconnected.read(
            "6",
            new AbortController().signal,
          )) {
            received.push(entry);
            if (received.length === 2) {
              break;
            }
          }
          return received;
        });
        expect(suffix.map(({ offset }) => offset)).toEqual(["7", "8"]);
        expect(JSON.stringify(suffix)).toContain(own);
        expect(JSON.stringify(suffix)).not.toContain(marker);
        const persisted = await scopedDb(
          async (tx) =>
            await tx
              .select({ state: chatRunLogs.referenceSummary })
              .from(chatRunLogs)
              .where(eq(chatRunLogs.runId, runId))
              .limit(1),
        );
        expect(JSON.stringify(persisted)).toContain(secret);
        return { chatRunLogEntries: entries, chatRunLogs: entries };
      },
  };
  type ExercisedStores = {
    [Case in keyof typeof surfaceCases]: keyof Awaited<
      ReturnType<(typeof surfaceCases)[Case]>
    >;
  }[keyof typeof surfaceCases];
  true satisfies Exclude<DecisionCopyStore, ExercisedStores> extends never
    ? true
    : never;
  true satisfies Exclude<ExercisedStores, DecisionCopyStore> extends never
    ? true
    : never;
  for (const [name, exercise] of Object.entries(surfaceCases)) {
    test(name, async () => {
      const stores = await exercise();
      for (const output of Object.values(stores)) {
        expect(JSON.stringify(output)).toContain(marker);
        expect(JSON.stringify(output)).not.toContain(secret);
      }
    });
  }

  test("authored exact chat titles outrank admitted body matches after withdrawal projection", async () => {
    const query = "admittedtierquartz";
    const authoredId = createSafeId<"chatThread">();
    const generatedId = createSafeId<"chatThread">();
    const rows = [
      { id: authoredId, titleSource: "user", text: "A retained note" },
      {
        id: generatedId,
        titleSource: "ai",
        text: Array.from({ length: 20 }, () => query).join(" "),
      },
    ] as const;
    seededThreads.push(authoredId, generatedId);
    await scopedDb(async (tx) => {
      await tx.insert(chatThreads).values(
        rows.map(({ id, titleSource }) => ({
          id,
          organizationId,
          userId,
          workspaceId,
          title: query,
          titleSource,
          subjectDecisionId: decisionId,
        })),
      );
      await tx.insert(chatMessages).values(
        rows.map(({ id, text }) => ({
          id: createSafeId<"chatMessage">(),
          threadId: id,
          userId,
          workspaceId,
          role: "user" as const,
          content: proveTextOnlyPersistedChatMessageContent({
            version: 3,
            data: [{ type: "text", content: text }],
          }),
        })),
      );
      await upsertChatThreadSearchDocument(authoredId, tx);
      await upsertChatThreadSearchDocument(generatedId, tx);
    });
    const searchPage = async (cursor?: string) =>
      await request(
        async () =>
          await searchGlobal(
            {
              organizationId,
              userId,
              accessibleWorkspaceIds: [workspaceId],
              selectedWorkspaceIds: [],
              types: ["chat"],
              editedByUserIds: [],
              mimeTypes: [],
              query,
              limit: 1,
              ...(cursor === undefined ? {} : { cursor }),
            },
            { scopedDb },
          ),
      );
    const first = await searchPage();
    expect(first.hits.map(({ id }) => id)).toEqual([`chat:${authoredId}`]);
    expect(first.hits.at(0)?.title).toBe(query);
    const second = await searchPage(
      first.nextCursor ?? panic("Expected a second admitted chat page"),
    );
    expect(second.hits.map(({ id }) => id)).toEqual([`chat:${generatedId}`]);
    expect(second.hits.at(0)?.title).toBe(marker);
  });

  test.each([
    { retained: "contract", query: "contract NOT negligence", matches: true },
    {
      retained: "contract negligence",
      query: "contract NOT negligence",
      matches: false,
    },
    { retained: "contract", query: "negligence", matches: false },
  ])(
    "chat search evaluates $query on retained text $retained",
    async ({ retained, query, matches }) => {
      const id = createSafeId<"chatThread">();
      seededThreads.push(id);
      await scopedDb(async (tx) => {
        await tx.insert(chatThreads).values({
          id,
          organizationId,
          userId,
          workspaceId,
          title: "Search fixture",
          titleSource: "user",
        });
        await tx.insert(chatMessages).values([
          {
            id: createSafeId<"chatMessage">(),
            threadId: id,
            userId,
            workspaceId,
            role: "user",
            content: proveTextOnlyPersistedChatMessageContent({
              version: 3,
              data: [{ type: "text", content: retained }],
            }),
          },
          {
            id: createSafeId<"chatMessage">(),
            threadId: id,
            userId,
            workspaceId,
            role: "assistant",
            content: proveTextOnlyPersistedChatMessageContent({
              version: 3,
              data: [
                {
                  type: "text",
                  content: `negligence [decision](#stella-decision=${decisionId})`,
                },
              ],
            }),
          },
        ]);
        await upsertChatThreadSearchDocument(id, tx);
      });
      const result = await request(async () =>
        searchGlobal(
          {
            organizationId,
            userId,
            accessibleWorkspaceIds: [workspaceId],
            selectedWorkspaceIds: [],
            types: ["chat"],
            editedByUserIds: [],
            mimeTypes: [],
            query,
            limit: 10,
          },
          { scopedDb },
        ),
      );
      expect(result.hits.some((hit) => hit.id === `chat:${id}`)).toBe(matches);
    },
  );

  test.each([
    { status: "withdrawn", titleSource: "ai", masked: true },
    { status: "active", titleSource: "ai", masked: false },
    { status: "withdrawn", titleSource: "user", masked: false },
  ] as const)(
    "generic $titleSource title preview follows its $status reference",
    async ({ status, titleSource, masked }) => {
      const id = createSafeId<"chatThread">();
      const reference = status === "withdrawn" ? decisionId : activeId;
      const title = `titleprobe [decision](#stella-decision=${reference})`;
      seededThreads.push(id);
      await scopedDb(async (tx) => {
        await tx.insert(chatThreads).values({
          id,
          organizationId,
          userId,
          workspaceId,
          title,
          titleSource,
        });
        await upsertChatThreadSearchDocument(id, tx);
      });
      const preview = await request(async () =>
        readSearchPreview(
          {
            organizationId,
            userId,
            accessibleWorkspaceIds: [workspaceId],
            type: "chat",
            resultId: id,
            query: "titleprobe",
          },
          scopedDb,
        ),
      );
      expect(preview).toEqual({
        type: "plain-text",
        content: masked ? marker : title,
      });
    },
  );

  test.each([
    {
      placement: "withdrawn slot",
      texts: ["alpha", "negligence", "beta"],
      withdrawn: true,
      query: '"alpha beta"',
      matches: false,
    },
    {
      placement: "adjacent retained messages",
      texts: ["alpha", "beta"],
      withdrawn: false,
      query: '"alpha beta"',
      matches: true,
    },
    {
      placement: "retained phrase",
      texts: ["alpha beta", "negligence", "gamma"],
      withdrawn: true,
      query: '"alpha beta"',
      matches: true,
    },
    {
      placement: "negated phrase across withdrawn slot",
      texts: ["alpha", "negligence", "beta"],
      withdrawn: true,
      query: 'alpha NOT "alpha beta"',
      matches: true,
    },
  ])(
    "projected phrase matching respects $placement",
    async ({ texts, withdrawn, query, matches }) => {
      const id = createSafeId<"chatThread">();
      seededThreads.push(id);
      await scopedDb(async (tx) => {
        await tx.insert(chatThreads).values({
          id,
          organizationId,
          userId,
          workspaceId,
          title: "Phrase fixture",
          titleSource: "user",
        });
        await tx.insert(chatMessages).values(
          texts.map((text, index) => ({
            id: createSafeId<"chatMessage">(),
            threadId: id,
            userId,
            workspaceId,
            role:
              index === 1 && withdrawn
                ? ("assistant" as const)
                : ("user" as const),
            createdAt: new Date(Date.UTC(2026, 9, 18, 10, index)),
            content: proveTextOnlyPersistedChatMessageContent({
              version: 3,
              data: [
                {
                  type: "text",
                  content:
                    index === 1 && withdrawn
                      ? `${text} [decision](#stella-decision=${decisionId})`
                      : text,
                },
              ],
            }),
          })),
        );
        await upsertChatThreadSearchDocument(id, tx);
      });
      const result = await request(async () =>
        searchGlobal(
          {
            organizationId,
            userId,
            accessibleWorkspaceIds: [workspaceId],
            selectedWorkspaceIds: [],
            types: ["chat"],
            editedByUserIds: [],
            mimeTypes: [],
            query,
            limit: 10,
          },
          { scopedDb },
        ),
      );
      expect(result.hits.some((hit) => hit.id === `chat:${id}`)).toBe(matches);
    },
  );

  test.each([
    {
      placement: "title and message",
      title: "titlequartz",
      messages: ["messageamber"],
      query: "titlequartz AND messageamber",
    },
    {
      placement: "two messages",
      title: "Thread",
      messages: ["firstquartz", "secondamber"],
      query: "firstquartz AND secondamber",
    },
    {
      placement: "a phrase across two messages",
      title: "Thread",
      messages: ["phrasequartz", "phraseamber"],
      query: '"phrasequartz phraseamber"',
    },
  ])(
    "chat search retains thread-level matches across $placement",
    async ({ title, messages, query }) => {
      const id = createSafeId<"chatThread">();
      seededThreads.push(id);
      await scopedDb(async (tx) => {
        await tx.insert(chatThreads).values({
          id,
          organizationId,
          userId,
          workspaceId,
          title,
          titleSource: "user",
          subjectDecisionId: activeId,
        });
        await tx.insert(chatMessages).values(
          messages.map((text, index) => ({
            id: createSafeId<"chatMessage">(),
            threadId: id,
            userId,
            workspaceId,
            role: "user" as const,
            createdAt: new Date(Date.UTC(2026, 9, 18, 10, index)),
            content: proveTextOnlyPersistedChatMessageContent({
              version: 3,
              data: [{ type: "text", content: text }],
            }),
          })),
        );
        await upsertChatThreadSearchDocument(id, tx);
        const indexed = await tx
          .select({
            matches: sql<boolean>`${chatThreadSearchDocuments.tsv} @@ ${buildSearchTsQuery(query)}`,
          })
          .from(chatThreadSearchDocuments)
          .where(eq(chatThreadSearchDocuments.threadId, id))
          .limit(1);
        expect(indexed.at(0)?.matches).toBe(true);
      });
      const result = await request(async () =>
        searchGlobal(
          {
            organizationId,
            userId,
            accessibleWorkspaceIds: [workspaceId],
            selectedWorkspaceIds: [],
            types: ["chat"],
            editedByUserIds: [],
            mimeTypes: [],
            query,
            limit: 10,
          },
          { scopedDb },
        ),
      );
      expect(result.hits.map((hit) => hit.id)).toEqual([`chat:${id}`]);
      expect(result.hits.at(0)?.title).toBe(title);
    },
  );

  test("filter-only chat browse pages directly beyond the text candidate ceiling", async () => {
    const updatedAt = new Date("2026-10-22T10:00:00Z");
    const rows = Array.from({ length: 1701 }, (_, index) => ({
      id: createSafeId<"chatThread">(),
      subjectDecisionId: index % 2 === 0 ? decisionId : activeId,
    }));
    seededThreads.push(...rows.map(({ id }) => id));
    await scopedDb(async (tx) => {
      await tx.insert(chatThreads).values(
        rows.map((row) => ({
          ...row,
          organizationId,
          userId,
          workspaceId,
          title: "Browse fixture",
          titleSource: "ai" as const,
          updatedAt,
        })),
      );
      await tx.insert(chatThreadSearchDocuments).values(
        rows.map(({ id }) => ({
          threadId: id,
          title: "Browse fixture",
          searchableText: "",
          tsv: chatSearchVectorSql(sql`'Browse fixture'`),
          previewGeneration: CHAT_SEARCH_DISPLAY_METADATA_GENERATION,
          updatedAt,
        })),
      );
    });
    const expected = rows.toSorted((a, b) => compareCodeUnit(b.id, a.id));
    let cursor: string | undefined;
    for (let page = 0; page < 3; page++) {
      const pageCursor = cursor;
      const result = await request(
        async () =>
          await runWithQueryCounter(
            async (counter) => {
              const response = await searchGlobal(
                {
                  organizationId,
                  userId,
                  accessibleWorkspaceIds: [workspaceId],
                  selectedWorkspaceIds: [],
                  types: ["chat"],
                  editedByUserIds: [],
                  mimeTypes: [],
                  query: "",
                  updatedFrom: "2026-10-22T00:00:00Z",
                  updatedTo: "2026-10-23T00:00:00Z",
                  limit: 17,
                  ...(pageCursor === undefined ? {} : { cursor: pageCursor }),
                },
                { scopedDb },
              );
              const pageReads = [...counter.fingerprints]
                .filter(([key]) => key.includes("t.title_source"))
                .reduce((total, [, count]) => total + count, 0);
              expect(pageReads).toBe(1);
              return response;
            },
            { detectRepeatedQueries: true },
          ),
      );
      const expectedPage = expected.slice(page * 17, (page + 1) * 17);
      expect(result.hits.map(({ id }) => id)).toEqual(
        expectedPage.map(({ id }) => `chat:${id}`),
      );
      expect(result.hits.map(({ title }) => title)).toEqual(
        expectedPage.map(({ subjectDecisionId }) =>
          subjectDecisionId === decisionId ? marker : "Browse fixture",
        ),
      );
      if (page === 0) {
        expect(result.totalCount).toBe(rows.length);
      }
      expect(result.nextCursor).not.toBeNull();
      cursor =
        result.nextCursor ?? panic("Browse fixture requires another page");
    }
  });

  test.each([
    { query: "paginateplain", masked: 0, admitted: 125 },
    { query: "paginatemasked", masked: 120, admitted: 73 },
  ])(
    "chat search paginates every admitted thread: $query",
    async ({ query, masked, admitted }) => {
      const now = new Date("2026-10-18T10:00:00Z");
      const rows = Array.from({ length: masked + admitted }, (_, index) => {
        const hidden = index < masked;
        const titleMasked = hidden || (masked > 0 && index % 3 === 0);
        return {
          id: createSafeId<"chatThread">(),
          messageId: createSafeId<"chatMessage">(),
          subjectDecisionId: titleMasked ? decisionId : activeId,
          title: titleMasked
            ? `${query} ${query} ${query} ${secret}`
            : "Thread",
          role: hidden ? ("assistant" as const) : ("user" as const),
          text: hidden ? `${query} ${secret}` : query,
          hidden,
        };
      });
      const olderMatch =
        rows.at(masked + 1) ??
        panic("Pagination fixture requires an admitted thread");
      const newerMessages =
        masked === 0
          ? []
          : Array.from({ length: 6 }, () => ({
              id: createSafeId<"chatMessage">(),
              threadId: olderMatch.id,
              text: `${query} ${secret} [decision](#stella-decision=${decisionId})`,
            }));
      const newerText = newerMessages.map(({ text }) => text).join(" ");
      seededThreads.push(...rows.map(({ id }) => id));
      await scopedDb(async (tx) => {
        await tx.insert(chatThreads).values(
          rows.map((row) => ({
            id: row.id,
            organizationId,
            userId,
            workspaceId,
            title: row.title,
            titleSource: "ai" as const,
            subjectDecisionId: row.subjectDecisionId,
          })),
        );
        await tx.insert(chatMessages).values(
          rows.map((row) => ({
            id: row.messageId,
            threadId: row.id,
            userId,
            workspaceId,
            role: row.role,
            content: proveTextOnlyPersistedChatMessageContent({
              version: 3,
              data: [{ type: "text", content: row.text }],
            }),
          })),
        );
        if (newerMessages.length > 0) {
          await tx.insert(chatMessages).values(
            newerMessages.map((row) => ({
              id: row.id,
              threadId: row.threadId,
              userId,
              workspaceId,
              role: "assistant" as const,
              content: proveTextOnlyPersistedChatMessageContent({
                version: 3,
                data: [{ type: "text", content: row.text }],
              }),
            })),
          );
          await tx.insert(chatMessageSearchDocuments).values(
            newerMessages.map((row) => ({
              messageId: row.id,
              threadId: row.threadId,
              role: "assistant" as const,
              searchableText: row.text,
              tsv: chatSearchVectorSql(sql`${row.text}`),
              createdAt: new Date("2026-10-19T10:00:00Z"),
            })),
          );
        }
        await tx.insert(chatThreadSearchDocuments).values(
          rows.map((row) => ({
            threadId: row.id,
            title: row.title,
            searchableText:
              row.id === olderMatch.id ? `${row.text} ${newerText}` : row.text,
            tsv: chatSearchVectorSql(
              sql`${`${row.title} ${row.text} ${row.id === olderMatch.id ? newerText : ""}`}`,
            ),
            previewGeneration: CHAT_SEARCH_DISPLAY_METADATA_GENERATION,
          })),
        );
        await tx.insert(chatMessageSearchDocuments).values(
          rows.map((row) => ({
            messageId: row.messageId,
            threadId: row.id,
            role: row.role,
            searchableText: row.text,
            tsv: chatSearchVectorSql(sql`${row.text}`),
            createdAt: now,
          })),
        );
      });
      const expected = rows
        .filter(({ hidden }) => !hidden)
        .map(({ id }) => `chat:${id}`)
        .toSorted((a, b) => compareCodeUnit(b, a));
      const received: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 16; page++) {
        const pageQuery = {
          organizationId,
          userId,
          accessibleWorkspaceIds: [workspaceId],
          selectedWorkspaceIds: [],
          types: ["chat"],
          editedByUserIds: [],
          mimeTypes: [],
          limit: 17,
          query,
          ...(cursor === undefined ? {} : { cursor }),
        } satisfies Parameters<typeof searchGlobal>[0];
        const result = await request(async () =>
          searchGlobal(pageQuery, { scopedDb }),
        );
        if (page === 0) {
          expect(result.totalCount).toBe(rows.length);
          expect(result.hits).toHaveLength(17);
        }
        expect(result.hits).toHaveLength(
          Math.min(17, admitted - received.length),
        );
        expect(JSON.stringify(result)).not.toContain(secret);
        received.push(...result.hits.map(({ id }) => id));
        if (result.nextCursor === null) {
          break;
        }
        cursor = result.nextCursor;
      }
      expect(received).toEqual(expected);
      expect(new Set(received).size).toBe(admitted);
    },
  );

  test.each(["direct", "cited", "linked"] as const)(
    "account export projects every reader message before serialization: %s withdrawal",
    async (association) => {
      const exportedAnswerId = createSafeId<"legalReaderAnswer">();
      const parentDecisionId = association === "direct" ? decisionId : activeId;
      await scopedDb(async (tx) => {
        await tx.insert(legalReaderAnswers).values({
          id: exportedAnswerId,
          organizationId,
          userId,
          decisionId: parentDecisionId,
          kind: "explain",
          paragraphId: "p1",
          startOffset: 0,
          endOffset: 12,
          quote: "Active quote",
        });
        await tx.insert(legalReaderAnswerMessages).values([
          {
            id: createSafeId<"legalReaderAnswerMessage">(),
            answerId: exportedAnswerId,
            sequence: 1,
            role: "user",
            content: own,
            status: "complete",
          },
          {
            id: createSafeId<"legalReaderAnswerMessage">(),
            answerId: exportedAnswerId,
            sequence: 2,
            role: "assistant",
            content:
              association === "linked"
                ? `${secret} [decision](#stella-decision=${decisionId})`
                : secret,
            citations:
              association === "linked"
                ? []
                : [{ decisionId, paragraphId: "p1" }],
            status: "complete",
          },
        ]);
      });
      try {
        let projected = false;
        const output = await request(async () => {
          const rows: unknown[] = [];
          for await (const row of exportAccountRows({
            db,
            scopedDatabase: markRlsDatabase(db),
            userId,
            table: "legal_reader_answers",
            signal: new AbortController().signal,
            projections: {
              ...ACCOUNT_EXPORT_PROJECTIONS,
              legal_reader_answers: (answer, messages) => {
                if (answer.id === exportedAnswerId) {
                  projected = true;
                  const assistant = messages.find(
                    ({ role }) => role === "assistant",
                  );
                  expect(assistant?.content).toBe(marker);
                  expect(assistant?.citations).toEqual([]);
                  expect(
                    messages.find(({ role }) => role === "user")?.content,
                  ).toBe(own);
                  expect(answer.quote).toBe(
                    association === "direct" ? marker : "Active quote",
                  );
                }
                return ACCOUNT_EXPORT_PROJECTIONS.legal_reader_answers(
                  answer,
                  messages,
                );
              },
            },
          })) {
            rows.push(row);
          }
          return rows;
        });
        expect(projected).toBe(true);
        expect(JSON.stringify(output)).toContain(own);
        expect(JSON.stringify(output)).not.toContain(secret);
      } finally {
        await scopedDb((tx) =>
          tx
            .delete(legalReaderAnswers)
            .where(eq(legalReaderAnswers.id, exportedAnswerId)),
        );
      }
    },
  );

  test("a withdrawal after the corpus read refuses model preparation before creating a turn", async () => {
    const readMessages = async () =>
      await scopedDb(
        async (tx) =>
          await tx
            .select()
            .from(legalReaderAnswerMessages)
            .where(eq(legalReaderAnswerMessages.answerId, answerId))
            .limit(50),
      );
    const before = await readMessages();
    const prepared = await request(
      async () =>
        await prepareReaderAnswer({
          ...scope,
          recordAuditEvent: async () => undefined,
          command: {
            type: "follow-up",
            answerId,
            body: { question: own, locale: "cs" },
          },
          readDecision: async () =>
            Result.ok({
              decisionId,
              court: "Fixture",
              decisionDate: null,
              language: "cs",
              paragraphs: [
                { paragraphId: "p1", text: secret },
                { paragraphId: "p2", text: secret },
              ],
            }),
        }),
    );
    expect(prepared.isErr()).toBe(true);
    if (prepared.isErr()) {
      expect(prepared.error.message).toBe(marker);
    }
    expect(await readMessages()).toEqual(before);
  });

  test.each([
    { operation: "snapshot", deltas: 10 },
    { operation: "snapshot", deltas: 300 },
    { operation: "read", deltas: 10 },
    { operation: "read", deltas: 300 },
  ] as const)(
    "the same log refreshes withdrawal verdicts between request-scoped $operation operations with $deltas deltas",
    async ({ operation, deltas }) => {
      const sourceDecisionId = createSafeId<"caseLawDecision">();
      seededDecisionIds.push(sourceDecisionId);
      await db.insert(caseLawDecisions).values({
        id: sourceDecisionId,
        sourceId,
        sourceDocumentId: sourceDecisionId,
        caseNumber: "Fixture",
        country: "POL",
        court: "Fixture",
        language: "pl",
        fulltext: secret,
        contentHash: "fixture",
      });
      const id = createSafeId<"chatThread">();
      seededThreads.push(id);
      const incomingId = createSafeId<"chatMessage">();
      const execution = {
        id: createSafeId<"chatTurn">(),
        executionId: Bun.randomUUIDv7(),
      };
      const replayRunId = Bun.randomUUIDv7();
      await scopedDb(async (tx) => {
        await tx.insert(chatThreads).values({
          id,
          organizationId,
          userId,
          workspaceId,
          title: own,
          titleSource: "user",
          subjectDecisionId: sourceDecisionId,
        });
        await tx.insert(chatMessages).values({
          id: incomingId,
          threadId: id,
          userId,
          workspaceId,
          role: "user",
          content: ownContent,
        });
        await tx.insert(chatTurns).values({
          id: execution.id,
          executionId: execution.executionId,
          organizationId,
          userId,
          workspaceId,
          threadId: id,
          userMessageId: incomingId,
          runId: replayRunId,
          status: "running",
          leaseExpiresAt: new Date(Date.now() + 60_000),
        });
      });
      const log = createChatRunLog({
        db: scopedDb,
        organizationId,
        runId: replayRunId,
        execution,
      });
      await log.append([
        { type: EventType.RUN_STARTED, runId: replayRunId, threadId: id },
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: incomingId,
          role: "user",
        },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: incomingId,
          delta: own,
        },
        { type: EventType.TEXT_MESSAGE_END, messageId: incomingId },
        { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" },
        ...Array.from(
          { length: deltas },
          () =>
            ({
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId,
              delta: secret,
            }) as const,
        ),
        { type: EventType.TEXT_MESSAGE_END, messageId },
        { type: EventType.RUN_FINISHED, runId: replayRunId, threadId: id },
      ]);
      await log.close();
      const read = async () =>
        await request(
          async () =>
            await runWithQueryCounter(
              async (counter) => {
                const entries = [];
                if (operation === "snapshot") {
                  entries.push(...(await log.snapshot()));
                } else {
                  for await (const entry of log.read(
                    "-1",
                    new AbortController().signal,
                  )) {
                    entries.push(entry);
                  }
                }
                const lookups = [...counter.fingerprints]
                  .filter(([key]) =>
                    key.includes('from "case_law_withdrawal_status"'),
                  )
                  .reduce((total, [, count]) => total + count, 0);
                expect(lookups).toBe(1);
                return entries;
              },
              { detectRepeatedQueries: true },
            ),
        );
      const before = await read();
      expect(JSON.stringify(before)).toContain(secret);
      expect(JSON.stringify(before)).toContain(own);
      const withdrawal = await redactCaseLawDecision({
        decisionId: sourceDecisionId,
        scopedDb: asTestRaw<ScopedDb>(
          async <T>(run: (tx: Transaction) => Promise<T>) =>
            await db.transaction(async (tx) => await run(asTestRaw(tx))),
        ),
        sweepRaw: async () => ({ type: "swept", legacy: "none" }),
        deleteCorpus: async (keys, options) =>
          await deleteCorpusDocument(keys, {
            ...options,
            deleteObject: async () => undefined,
          }),
      });
      expect(withdrawal.isOk()).toBe(true);
      const after = await read();
      expect(after.map(({ offset }) => offset)).toEqual(
        before.map(({ offset }) => offset),
      );
      expect(JSON.stringify(after)).toContain(marker);
      expect(JSON.stringify(after)).not.toContain(secret);
      expect(JSON.stringify(after)).toContain(own);
    },
  );

  test("reconnecting at now emits the withdrawal marker for newly delivered text", async () => {
    const id = createSafeId<"chatThread">();
    seededThreads.push(id);
    const incomingId = createSafeId<"chatMessage">();
    const assistantId = createSafeId<"chatMessage">();
    const execution = {
      id: createSafeId<"chatTurn">(),
      executionId: Bun.randomUUIDv7(),
    };
    const liveRunId = Bun.randomUUIDv7();
    await scopedDb(async (tx) => {
      await tx.insert(chatThreads).values({
        id,
        organizationId,
        userId,
        workspaceId,
        title: own,
        titleSource: "user",
        subjectDecisionId: decisionId,
      });
      await tx.insert(chatMessages).values({
        id: incomingId,
        threadId: id,
        userId,
        workspaceId,
        role: "user",
        content: ownContent,
      });
      await tx.insert(chatTurns).values({
        id: execution.id,
        executionId: execution.executionId,
        organizationId,
        userId,
        workspaceId,
        threadId: id,
        userMessageId: incomingId,
        runId: liveRunId,
        status: "running",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      });
    });
    const options = { organizationId, runId: liveRunId, execution };
    const writer = createChatRunLog({ ...options, db: scopedDb });
    await writer.append([
      { type: EventType.RUN_STARTED, runId: liveRunId, threadId: id },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: assistantId,
        role: "assistant",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: assistantId,
        delta: secret,
      },
    ]);
    const initialized = Promise.withResolvers<undefined>();
    const observedDb = (async (read) => {
      const result = await scopedDb(read);
      initialized.resolve(undefined);
      return result;
    }) satisfies ScopedDb;
    const reconnected = createChatRunLog({ ...options, db: observedDb });
    await request(async () => {
      const controller = new AbortController();
      const delivery = reconnected.read("now", controller.signal);
      const reader = delivery[Symbol.asyncIterator]();
      const pending = reader.next();
      try {
        await initialized.promise;
        await writer.append([
          {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: assistantId,
            delta: secret,
          },
        ]);
        await writer.close();
        expect(await pending).toEqual({
          done: false,
          value: {
            offset: "4",
            chunk: {
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId: assistantId,
              delta: marker,
            },
          },
        });
        expect(await reader.next()).toEqual({ done: true, value: undefined });
      } finally {
        controller.abort();
        await reader.return?.();
      }
    });
  });

  test.each(
    [
      { split: "scheme", deltas: 2, delivery: "existing" },
      { split: "scheme", deltas: 3, delivery: "existing" },
      { split: "id", deltas: 2, delivery: "existing" },
      { split: "id", deltas: 3, delivery: "existing" },
      { split: "scheme", deltas: 2, delivery: "tail" },
      { split: "scheme", deltas: 3, delivery: "tail" },
      { split: "id", deltas: 2, delivery: "tail" },
      { split: "id", deltas: 3, delivery: "tail" },
      { split: "id", deltas: 2, delivery: "separate messages" },
    ].flatMap((testCase) =>
      (
        [EventType.TEXT_MESSAGE_CONTENT, EventType.TEXT_MESSAGE_CHUNK] as const
      ).map((event) => ({
        ...testCase,
        event,
      })),
    ),
  )(
    "running generic logs reconstruct $deltas deltas split inside $split ($delivery, $event)",
    async ({ split, deltas, delivery, event }) => {
      const id = createSafeId<"chatThread">();
      seededThreads.push(id);
      const incomingId = createSafeId<"chatMessage">();
      const assistantId = createSafeId<"chatMessage">();
      const execution = {
        id: createSafeId<"chatTurn">(),
        executionId: Bun.randomUUIDv7(),
      };
      const liveRunId = Bun.randomUUIDv7();
      await scopedDb(async (tx) => {
        await tx.insert(chatThreads).values({
          id,
          organizationId,
          userId,
          workspaceId,
          title: own,
          titleSource: "user",
        });
        await tx.insert(chatMessages).values({
          id: incomingId,
          threadId: id,
          userId,
          workspaceId,
          role: "user",
          content: ownContent,
        });
        await tx.insert(chatTurns).values({
          id: execution.id,
          executionId: execution.executionId,
          organizationId,
          userId,
          workspaceId,
          threadId: id,
          userMessageId: incomingId,
          runId: liveRunId,
          status: "running",
          leaseExpiresAt: new Date(Date.now() + 60_000),
        });
      });
      const text = `[decision](#stella-decision=${decisionId}) ${secret}`;
      const boundary =
        split === "scheme"
          ? text.indexOf("#stella") + 3
          : text.indexOf(decisionId) + 12;
      const cuts = deltas === 2 ? [boundary] : [boundary, boundary + 2];
      const pieces = [0, ...cuts].map((start, index) =>
        text.slice(start, cuts.at(index)),
      );
      expect([...decisionReferencesIn(text)]).toEqual([decisionId]);
      for (const piece of pieces) {
        expect(decisionReferencesIn(piece).size).toBe(0);
      }
      const prefix = pieces.slice(0, -1);
      const final =
        pieces.at(-1) ?? panic("Split stream requires a final delta");
      const log = createChatRunLog({
        db: scopedDb,
        organizationId,
        runId: liveRunId,
        execution,
      });
      const textDelta = (delta: string) => {
        switch (event) {
          case EventType.TEXT_MESSAGE_CONTENT:
            return {
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId: assistantId,
              delta,
            } as const;
          case EventType.TEXT_MESSAGE_CHUNK:
            return {
              type: EventType.TEXT_MESSAGE_CHUNK,
              messageId: assistantId,
              delta,
            } as const;
          default:
            event satisfies never;
            return panic("Missing stream fixture event");
        }
      };
      const initial = [
        { type: EventType.RUN_STARTED, runId: liveRunId, threadId: id },
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: assistantId,
          role: "assistant",
        },
        ...prefix.map(textDelta),
      ] satisfies StreamChunk[];
      const suffix = (
        delivery === "separate messages"
          ? [
              { type: EventType.TEXT_MESSAGE_END, messageId: assistantId },
              {
                type: EventType.TEXT_MESSAGE_START,
                messageId,
                role: "assistant",
              },
              { ...textDelta(final), messageId },
            ]
          : [textDelta(final)]
      ) satisfies StreamChunk[];
      await log.append(initial);
      if (delivery !== "tail") {
        await log.append(suffix);
        const snapshot = await request(async () => await log.snapshot());
        expect(JSON.stringify(snapshot)).toContain(
          delivery === "separate messages" ? secret : marker,
        );
        if (delivery !== "separate messages") {
          expect(JSON.stringify(snapshot)).not.toContain(secret);
        }
      }
      await request(async () => {
        const controller = new AbortController();
        const stream = log.read("-1", controller.signal);
        const reader = stream[Symbol.asyncIterator]();
        try {
          const entries = [];
          for (const expectedChunk of initial) {
            const entry = await reader.next();
            if (entry.done) {
              panic("Expected another running log entry");
            }
            expect(entry.value.chunk.type).toBe(expectedChunk.type);
            entries.push(entry.value);
          }
          if (delivery === "tail") {
            await log.append(suffix);
          }
          for (const expectedChunk of suffix) {
            const entry = await reader.next();
            if (entry.done) {
              panic("Expected another running log entry");
            }
            expect(entry.value.chunk.type).toBe(expectedChunk.type);
            entries.push(entry.value);
          }
          expect(entries.map((entry) => entry.offset)).toEqual(
            Array.from({ length: initial.length + suffix.length }, (_, index) =>
              String(index + 1),
            ),
          );
          if (delivery === "separate messages") {
            expect(JSON.stringify(entries)).toContain(secret);
            expect(JSON.stringify(entries)).not.toContain(marker);
            return;
          }
          expect(JSON.stringify(entries)).not.toContain(secret);
          expect(JSON.stringify(entries)).toContain(marker);
          const capture = createStreamMessageCapture({
            initialMessages: [],
            capture: (message) => message,
          });
          for (const entry of entries) {
            capture.processor.processChunk(entry.chunk);
          }
          expect(JSON.stringify(capture.processor.getMessages())).toContain(
            marker,
          );
          expect(JSON.stringify(capture.processor.getMessages())).not.toContain(
            secret,
          );
        } finally {
          controller.abort();
          await reader.return?.();
        }
      });
    },
  );

  test.each(
    (["answer", "run"] as const).flatMap((field) =>
      (["withdrawn", "active"] as const).map((source) => ({ field, source })),
    ),
  )(
    "available research owner projects its $field reference ($source)",
    async ({ field, source }) => {
      const link = ` [decision](#stella-decision=${source === "withdrawn" ? decisionId : activeId})`;
      const value = {
        columnId,
        organizationId,
        decisionId: activeId,
        state: "answered",
        answer: {
          version: 1,
          type: "text",
          value: `${secret}${field === "answer" ? link : ""}`,
        },
        run: {
          version: 1,
          model: "fixture",
          completedAt: "2026-10-28T00:00:00.000Z",
          retrieved: false,
          rationale: `${secret}${field === "run" ? link : ""}`,
          justification: { version: 1, blocks: [] },
        },
      } satisfies typeof caseLawResearchAnswers.$inferInsert;
      await scopedDb(
        async (tx) =>
          await tx
            .insert(caseLawResearchAnswers)
            .values(value)
            .onConflictDoUpdate({
              target: [
                caseLawResearchAnswers.columnId,
                caseLawResearchAnswers.decisionId,
              ],
              set: value,
            }),
      );
      const result = (
        await request(
          async () =>
            await readResearchAnswers({
              safeDb,
              organizationId,
              decisionIds: [activeId],
            }),
        )
      ).unwrap();
      expect(result).toHaveLength(1);
      if (source === "withdrawn") {
        expect(result.at(0)).toMatchObject({
          decisionId: activeId,
          state: "withdrawn",
          answer: null,
          run: null,
          withdrawnMarker: marker,
        });
        expect(JSON.stringify(result)).not.toContain(secret);
      } else {
        expect(result.at(0)).toMatchObject({
          decisionId: activeId,
          state: "answered",
          answer: value.answer,
          run: value.run,
          withdrawnMarker: null,
        });
      }
    },
  );

  const liveLogFixture = async (subject: "generic" | "active subject") => {
    const id = createSafeId<"chatThread">();
    seededThreads.push(id);
    const incomingId = createSafeId<"chatMessage">();
    const execution = {
      id: createSafeId<"chatTurn">(),
      executionId: Bun.randomUUIDv7(),
    };
    const liveRunId = Bun.randomUUIDv7();
    await scopedDb(async (tx) => {
      await tx.insert(chatThreads).values({
        id,
        organizationId,
        userId,
        workspaceId,
        title: own,
        titleSource: "user",
        subjectDecisionId: subject === "active subject" ? activeId : null,
      });
      await tx.insert(chatMessages).values({
        id: incomingId,
        threadId: id,
        userId,
        workspaceId,
        role: "user",
        content: ownContent,
      });
      await tx.insert(chatTurns).values({
        id: execution.id,
        executionId: execution.executionId,
        organizationId,
        userId,
        workspaceId,
        threadId: id,
        userMessageId: incomingId,
        runId: liveRunId,
        status: "running",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      });
    });
    const options = { organizationId, runId: liveRunId, execution };
    return {
      options,
      threadId: id,
      writer: createChatRunLog({ ...options, db: scopedDb }),
    };
  };

  test.each(
    (["direct", "replay", "compact"] as const).flatMap((mode) =>
      (["withdrawn", "active"] as const).flatMap((source) =>
        (["generic", "active subject"] as const).map((subject) => ({
          mode,
          source,
          subject,
        })),
      ),
    ),
  )(
    "open $subject $mode delivers text and interaction before close ($source)",
    async ({ mode, source, subject }) => {
      const {
        writer,
        options,
        threadId: genericThreadId,
      } = await liveLogFixture(subject);
      const assistantId = createSafeId<"chatMessage">();
      const prefix = [
        {
          type: EventType.RUN_STARTED,
          runId: options.runId,
          threadId: genericThreadId,
        },
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: assistantId,
          role: "assistant",
        },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: assistantId,
          delta: secret,
        },
        ...Array.from(
          { length: mode === "compact" ? 260 : 0 },
          () =>
            ({
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId: assistantId,
              delta: ".",
            }) as const,
        ),
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "question",
          toolCallName: "ask-user",
          parentMessageId: assistantId,
        },
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: "question",
          delta: JSON.stringify({ question: own }),
        },
        { type: EventType.TOOL_CALL_END, toolCallId: "question" },
      ] satisfies StreamChunk[];
      await writer.append(prefix);
      const polled = Promise.withResolvers<undefined>();
      let reads = 0;
      const observedDb = (async (read) => {
        reads++;
        if (reads === 2) {
          polled.resolve(undefined);
        }
        return await scopedDb(read);
      }) satisfies ScopedDb;
      const delivery =
        mode === "direct"
          ? createChatRunLog({ ...options, db: observedDb })
          : ((await createChatRunLogReplay({
              db: observedDb,
              organizationId,
              runId: options.runId,
              resumeOffset: "-1",
            })) ?? panic("Expected live replay"));
      reads = 0;
      await request(async () => {
        const controller = new AbortController();
        const entries: Awaited<ReturnType<typeof writer.snapshot>> = [];
        const consume = (async () => {
          for await (const entry of delivery.read("-1", controller.signal)) {
            entries.push(entry);
          }
        })();
        try {
          await polled.promise;
          expect(JSON.stringify(entries)).toContain(secret);
          const live = createStreamMessageCapture({
            initialMessages: [],
            capture: (message) => message,
          });
          for (const entry of entries) {
            live.processor.processChunk(entry.chunk);
          }
          expect(live.processor.getMessages().at(0)?.parts).toContainEqual(
            expect.objectContaining({
              type: "tool-call",
              name: "ask-user",
              state: "input-complete",
              arguments: JSON.stringify({ question: own }),
            }),
          );
          const link = ` [decision](#stella-decision=${source === "withdrawn" ? decisionId : activeId})`;
          const suffix = [
            {
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId: assistantId,
              delta: link,
            },
            { type: EventType.TEXT_MESSAGE_END, messageId: assistantId },
            {
              type: EventType.RUN_FINISHED,
              runId: options.runId,
              threadId: genericThreadId,
            },
          ] satisfies StreamChunk[];
          await writer.append(suffix);
          await writer.close();
          await consume;
          const capture = createStreamMessageCapture({
            initialMessages: [],
            capture: (message) => message,
          });
          for (const entry of entries) {
            capture.processor.processChunk(entry.chunk);
          }
          const messages = JSON.stringify(capture.processor.getMessages());
          if (source === "withdrawn") {
            const snapshot = await writer.snapshot();
            expect(JSON.stringify(snapshot)).toContain(marker);
            expect(JSON.stringify(snapshot)).not.toContain(secret);
            const closed = [];
            for await (const entry of writer.read("-1")) {
              closed.push(entry);
            }
            expect(closed).toEqual(snapshot);
          } else {
            if (mode !== "compact") {
              expect(entries.map(({ chunk }) => chunk)).toEqual([
                ...prefix,
                ...suffix,
              ]);
            }
            expect(
              capture.processor
                .getMessages()
                .at(0)
                ?.parts.flatMap((part) =>
                  part.type === "text" ? [part.content] : [],
                )
                .join(""),
            ).toBe(
              `${secret}${".".repeat(mode === "compact" ? 260 : 0)}${link}`,
            );
            expect(messages).not.toContain(marker);
          }
          expect(entries.map(({ offset }) => BigInt(offset))).toEqual(
            entries
              .map(({ offset }) => BigInt(offset))
              .toSorted((a, b) => {
                if (a === b) {
                  return 0;
                }
                return a < b ? -1 : 1;
              }),
          );
        } finally {
          controller.abort();
          await consume;
        }
      });
    },
  );

  test.each(["direct", "reconnect", "now"] as const)(
    "large run resumed near its tail has bounded history reads: %s",
    async (mode) => {
      const measure = async (prefixCount: number) =>
        await withGatedTestClients(
          process.env["DATABASE_URL"] ??
            panic("Postgres fixture requires DATABASE_URL"),
          async ({ openClient }) => {
            const queries: string[] = [];
            const readDb = createScopedDb(
              markRlsDatabase(
                openClient({
                  max: 1,
                  logger: {
                    logQuery: (query) => {
                      queries.push(query);
                    },
                  },
                }).db,
              ),
              [workspaceId],
              organizationId,
              userId,
            );
            const { writer, options } = await liveLogFixture("generic");
            const tailMessageId = createSafeId<"chatMessage">();
            const prefix = [
              {
                type: EventType.TEXT_MESSAGE_START,
                messageId: tailMessageId,
                role: "assistant",
              },
              ...Array.from(
                { length: prefixCount },
                () =>
                  ({
                    type: EventType.TEXT_MESSAGE_CONTENT,
                    messageId: tailMessageId,
                    delta: "x".repeat(2048),
                  }) as const,
              ),
            ] satisfies StreamChunk[];
            await writer.append(prefix);
            let bytes = 0;
            let rows = 0;
            let calls = 0;
            const ready = Promise.withResolvers<undefined>();
            const written = Promise.withResolvers<undefined>();
            const measuredDb = (async (read) => {
              const result = await readDb(read);
              bytes += Buffer.byteLength(
                JSON.stringify(result, (_key, value: unknown) =>
                  typeof value === "bigint" ? value.toString() : value,
                ),
              );
              if (
                typeof result === "object" &&
                result !== null &&
                "entries" in result &&
                Array.isArray(result.entries)
              ) {
                rows += result.entries.length + 1;
              } else {
                rows += 1;
              }
              calls++;
              if (mode === "now" && calls === 2) {
                ready.resolve(undefined);
                await written.promise;
              }
              return result;
            }) satisfies ScopedDb;
            const offset = mode === "now" ? "now" : prefix.length.toString();
            const delivery =
              mode === "reconnect"
                ? ((await createChatRunLogReplay({
                    db: measuredDb,
                    organizationId,
                    runId: options.runId,
                    resumeOffset: offset,
                  })) ?? panic("Expected live replay"))
                : createChatRunLog({ ...options, db: measuredDb });
            const controller = new AbortController();
            const received: StreamChunk[] = [];
            const suffix = [
              {
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId: tailMessageId,
                delta: own,
              },
            ] satisfies StreamChunk[];
            if (mode !== "now") {
              await writer.append(suffix);
            }
            const stream = delivery.read(offset, controller.signal);
            const iterator = stream[Symbol.asyncIterator]();
            const consume = iterator.next().then((entry) => {
              if (entry.done) {
                panic("Expected the new tail entry");
              }
              received.push(entry.value.chunk);
              return undefined;
            });
            if (mode === "now") {
              await ready.promise;
              await writer.append(suffix);
            }
            written.resolve(undefined);
            try {
              await consume;
              expect(received).toEqual([
                {
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  messageId: tailMessageId,
                  delta: own,
                },
              ]);
              return { queries, bytes, rows };
            } finally {
              written.resolve(undefined);
              controller.abort();
              await consume;
              await iterator.return?.();
              await writer.close();
            }
          },
        );
      const small = await measure(10);
      const large = await measure(1000);
      for (const { queries, bytes, rows } of [small, large]) {
        expect(bytes).toBeLessThan(CHAT_RUN_REFERENCE_STATE_MAX_BYTES + 4096);
        expect(
          queries.every(
            (query) =>
              !query.includes("jsonb_agg") &&
              !query.includes("sum(octet_length"),
          ),
        ).toBe(true);
        const entryPages = queries.filter((query) =>
          query.includes('from "chat_run_log_entries"'),
        );
        expect(entryPages.length).toBeGreaterThan(0);
        expect(entryPages.every((query) => /limit \$\d+/u.test(query))).toBe(
          true,
        );
        expect(rows).toBeLessThanOrEqual(READ_PAGE_SIZE + 4);
        if (mode === "now") {
          expect(
            queries.every(
              (query) =>
                !query.includes('"reference_summary"') &&
                !query.includes("CASE WHEN octet_length"),
            ),
          ).toBe(true);
        }
      }
      expect(large.queries.length).toBe(small.queries.length);
      expect(large.rows).toBe(small.rows);
      expect(large.bytes).toBeLessThanOrEqual(small.bytes + 1024);
    },
  );

  test.each(
    [false, true].flatMap((withdrawn) =>
      (["snapshot", "cursor"] as const).map((mode) => ({ withdrawn, mode })),
    ),
  )(
    "closed $mode replay reads a multi-chunk persisted answer (withdrawn link: $withdrawn)",
    async ({ withdrawn, mode }) => {
      const { writer, options, threadId: id } = await liveLogFixture("generic");
      const persistedAnswerId = createSafeId<"chatMessage">();
      const pieces = [
        "a".repeat(600 * 1024),
        "b".repeat(600 * 1024),
        withdrawn
          ? ` [decision](#stella-decision=${decisionId})`
          : " retained answer",
      ];
      const text = pieces.join("");
      const sourceChunks = pieces.map((delta) => ({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: persistedAnswerId,
        delta,
      })) satisfies StreamChunk[];
      expect(
        sourceChunks.every(
          (chunk) => Buffer.byteLength(JSON.stringify(chunk)) < 1024 * 1024,
        ),
      ).toBe(true);
      expect(Buffer.byteLength(text)).toBeGreaterThan(1024 * 1024);
      await scopedDb(async (tx) => {
        await tx.insert(chatMessages).values({
          id: persistedAnswerId,
          threadId: id,
          userId,
          workspaceId,
          role: "assistant",
          content: proveTextOnlyPersistedChatMessageContent({
            version: 3,
            data: [{ type: "text", content: text }],
          }),
        });
        await tx
          .update(chatTurns)
          .set({ timingMessageId: persistedAnswerId })
          .where(eq(chatTurns.id, options.execution.id));
      });
      // A resumed producer's persisted prefix can precede its checkpointed durable suffix.
      await writer.append([
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: persistedAnswerId,
          role: "assistant",
        },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: persistedAnswerId,
          delta: "tail answer",
        },
        { type: EventType.TEXT_MESSAGE_END, messageId: persistedAnswerId },
      ]);
      await writer.close();
      const state = await scopedDb(
        async (tx) =>
          await tx
            .select({ summary: chatRunLogs.referenceSummary })
            .from(chatRunLogs)
            .where(eq(chatRunLogs.runId, options.runId))
            .limit(1),
      );
      expect(state.at(0)?.summary).toMatchObject({
        type: "checkpointed",
        decisionIds: [],
      });
      const replayed = await request(async () => {
        if (mode === "snapshot") {
          return await writer.snapshot();
        }
        const replay = createChatRunLog({
          ...options,
          db: scopedDb,
          resumeOffset: "1",
        });
        const entries = [];
        for await (const entry of replay.read(
          "1",
          new AbortController().signal,
        )) {
          entries.push(entry);
        }
        return entries;
      });
      expect(
        replayed.find(
          ({ chunk }) => chunk.type === EventType.TEXT_MESSAGE_CONTENT,
        )?.chunk,
      ).toEqual({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: persistedAnswerId,
        delta: withdrawn ? marker : "tail answer",
      });
    },
  );

  test.each(
    [
      {
        label: "assistant introduction",
        first: "assistant",
        next: "same",
        final: "assistant",
      },
      {
        label: "user introduction",
        first: "user",
        next: "same",
        final: "user",
      },
      {
        label: "unchanged assistant labels",
        first: "assistant",
        next: "repeat",
        final: "assistant",
      },
      {
        label: "unchanged user labels",
        first: "user",
        next: "repeat",
        final: "user",
      },
      {
        label: "empty snapshot",
        first: "assistant",
        next: "empty",
        final: "assistant",
      },
      {
        label: "assistant relabeled user",
        first: "assistant",
        next: "user",
        final: "user",
      },
      {
        label: "user relabeled assistant",
        first: "user",
        next: "assistant",
        final: "assistant",
      },
      {
        label: "application state",
        first: "assistant",
        next: "state",
        final: "assistant",
      },
    ].flatMap((scenario) =>
      (["snapshot", "cursor"] as const).map((mode) => ({ ...scenario, mode })),
    ),
  )(
    "$mode replay attributes snapshot messages: $label",
    async ({ first, next, final, mode }) => {
      const {
        writer,
        options,
        threadId: snapshotThread,
      } = await liveLogFixture("generic");
      await scopedDb(
        async (tx) =>
          await tx
            .update(chatThreads)
            .set({ subjectDecisionId: decisionId })
            .where(eq(chatThreads.id, snapshotThread)),
      );
      const identity = createSafeId<"chatMessage">();
      const role = first === "user" ? "user" : "assistant";
      const initial = buildWireSnapshot([
        { id: identity, role, content: "prior" },
      ]);
      const declaredRole = next === "repeat" ? role : next;
      const replacementRole = declaredRole === "user" ? "user" : "assistant";
      const continuation =
        next === "state"
          ? ({
              type: EventType.STATE_SNAPSHOT,
              snapshot: { messages: [{ id: identity, role: "user" }] },
            } satisfies StreamChunk)
          : buildWireSnapshot(
              next === "empty"
                ? []
                : [{ id: identity, role: replacementRole, content: "prior" }],
            );
      const additional = next === "same" ? [] : [continuation];
      const prefix = [initial, ...additional];
      await writer.append(prefix);
      const cursor = String(prefix.length);
      const delta = final === "user" ? own : secret;
      await writer.append([
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: identity, delta },
        { type: EventType.TEXT_MESSAGE_END, messageId: identity },
      ]);
      await writer.close();
      const received = await request(async () => {
        if (mode === "snapshot") {
          return await writer.snapshot();
        }
        const viewer = createChatRunLog({
          ...options,
          db: scopedDb,
          resumeOffset: cursor,
        });
        const entries = [];
        for await (const entry of viewer.read(
          cursor,
          new AbortController().signal,
        )) {
          entries.push(entry);
        }
        return entries;
      });
      expect(
        received.find(
          ({ chunk }) => chunk.type === EventType.TEXT_MESSAGE_CONTENT,
        )?.chunk,
      ).toEqual({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: identity,
        delta: final === "user" ? own : marker,
      });
    },
  );

  test.each(
    (["assistant", "user"] as const).flatMap((initialRole) =>
      (["snapshot", "cursor", "after-relabel"] as const).map((mode) => ({
        initialRole,
        mode,
      })),
    ),
  )(
    "$mode replay keeps snapshot relabeling at its sequence ($initialRole first)",
    async ({ initialRole, mode }) => {
      const {
        writer,
        options,
        threadId: snapshotThread,
      } = await liveLogFixture("generic");
      await scopedDb(
        async (tx) =>
          await tx
            .update(chatThreads)
            .set({ subjectDecisionId: decisionId })
            .where(eq(chatThreads.id, snapshotThread)),
      );
      const identity = createSafeId<"chatMessage">();
      const laterRole = initialRole === "user" ? "assistant" : "user";
      const initialText = initialRole === "user" ? own : secret;
      const laterText = laterRole === "user" ? own : secret;
      await writer.append([
        buildWireSnapshot([
          { id: identity, role: initialRole, content: "prior" },
        ]),
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: identity,
          delta: initialText,
        },
        buildWireSnapshot([
          { id: identity, role: laterRole, content: "prior" },
        ]),
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: identity,
          delta: laterText,
        },
        { type: EventType.TEXT_MESSAGE_END, messageId: identity },
      ]);
      await writer.close();
      const cursor = mode === "after-relabel" ? "3" : "1";
      const received = await request(async () => {
        if (mode === "snapshot") {
          return await writer.snapshot();
        }
        const viewer = createChatRunLog({ ...options, db: scopedDb });
        const entries = [];
        for await (const entry of viewer.read(
          cursor,
          new AbortController().signal,
        )) {
          entries.push(entry);
        }
        return entries;
      });
      const expected = [
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: identity,
          delta: laterRole === "user" ? own : marker,
        },
      ] satisfies StreamChunk[];
      if (mode !== "after-relabel") {
        expected.unshift({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: identity,
          delta: initialRole === "user" ? own : marker,
        });
      }
      expect(
        received
          .filter(({ chunk }) => chunk.type === EventType.TEXT_MESSAGE_CONTENT)
          .map(({ chunk }) => chunk),
      ).toEqual(expected);
    },
  );

  test.each(
    (["assistant", "user"] as const).flatMap((initialRole) =>
      (["snapshot", "cursor", "after-relabel"] as const).map((mode) => ({
        initialRole,
        mode,
      })),
    ),
  )(
    "$mode replay follows the current snapshot role for implicit chunks ($initialRole first)",
    async ({ initialRole, mode }) => {
      const {
        writer,
        options,
        threadId: snapshotThread,
      } = await liveLogFixture("generic");
      await scopedDb(
        async (tx) =>
          await tx
            .update(chatThreads)
            .set({ subjectDecisionId: decisionId })
            .where(eq(chatThreads.id, snapshotThread)),
      );
      const identity = createSafeId<"chatMessage">();
      const laterRole = initialRole === "user" ? "assistant" : "user";
      const delta = laterRole === "user" ? own : secret;
      await writer.append([
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: identity,
          role: initialRole,
        },
        buildWireSnapshot([
          { id: identity, role: laterRole, content: "prior" },
        ]),
        { type: EventType.TEXT_MESSAGE_CHUNK, delta },
        { type: EventType.TEXT_MESSAGE_END, messageId: identity },
      ]);
      await writer.close();
      const received = await request(async () => {
        if (mode === "snapshot") {
          return await writer.snapshot();
        }
        const viewer = createChatRunLog({ ...options, db: scopedDb });
        const entries = [];
        const cursor = mode === "after-relabel" ? "2" : "1";
        for await (const entry of viewer.read(
          cursor,
          new AbortController().signal,
        )) {
          entries.push(entry);
        }
        return entries;
      });
      expect(
        received.find(
          ({ chunk }) => chunk.type === EventType.TEXT_MESSAGE_CHUNK,
        )?.chunk,
      ).toEqual({
        type: EventType.TEXT_MESSAGE_CHUNK,
        delta: laterRole === "user" ? own : marker,
      });
    },
  );

  test.each(["now", "cursor"] as const)(
    "%s restores every open message role before interleaved deltas",
    async (mode) => {
      const {
        writer,
        options,
        threadId: subjectThread,
      } = await liveLogFixture("generic");
      await scopedDb(
        async (tx) =>
          await tx
            .update(chatThreads)
            .set({ subjectDecisionId: decisionId })
            .where(eq(chatThreads.id, subjectThread)),
      );
      const firstUser = createSafeId<"chatMessage">();
      const assistant = createSafeId<"chatMessage">();
      const secondUser = createSafeId<"chatMessage">();
      const prefix = [
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: firstUser,
          role: "user",
        },
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: assistant,
          role: "assistant",
        },
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: secondUser,
          role: "user",
        },
      ] satisfies StreamChunk[];
      await writer.append(prefix);
      const ready = Promise.withResolvers<undefined>();
      let reads = 0;
      const observedDb = (async (read) => {
        reads++;
        if (reads === (mode === "now" ? 2 : 1)) {
          ready.resolve(undefined);
        }
        return await scopedDb(read);
      }) satisfies ScopedDb;
      const live = createChatRunLog({ ...options, db: observedDb });
      const delivery = live.read(
        mode === "now" ? "now" : String(prefix.length),
      );
      const iterator = delivery[Symbol.asyncIterator]();
      const first = request(async () => await iterator.next());
      await ready.promise;
      const suffix = [
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: assistant,
          delta: secret,
        },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: firstUser,
          delta: `${own} first`,
        },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: secondUser,
          delta: `${own} second`,
        },
      ] satisfies StreamChunk[];
      await writer.append(suffix);
      const delivered = [
        await first,
        await request(async () => await iterator.next()),
        await request(async () => await iterator.next()),
      ];
      expect(delivered.map(({ value }) => value?.chunk)).toEqual([
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: assistant,
          delta: marker,
        },
        suffix[1],
        suffix[2],
      ]);
      await writer.close();
      expect((await iterator.next()).done).toBe(true);
    },
  );

  test.each(
    (["tool", "structured"] as const).flatMap((kind) =>
      [40 * 1024, 300 * 1024].map((bytes) => ({ kind, bytes })),
    ),
  )(
    "current producer delivers $bytes-byte $kind inputs and masks closed replay",
    async ({ kind, bytes }) => {
      const { writer, options } = await liveLogFixture("generic");
      const assistantId = createSafeId<"chatMessage">();
      await writer.append([
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: assistantId,
          role: "assistant",
        },
      ]);
      const referenceSummary = async () =>
        await scopedDb(
          async (tx) =>
            (
              await tx
                .select({ state: chatRunLogs.referenceSummary })
                .from(chatRunLogs)
                .where(eq(chatRunLogs.runId, options.runId))
                .limit(1)
            ).at(0)?.state,
        );
      expect((await referenceSummary())?.type).toBe("checkpointed");
      const ready = Promise.withResolvers<undefined>();
      let reads = 0;
      const observedDb = (async (read) => {
        reads++;
        if (reads === 2) {
          ready.resolve(undefined);
        }
        return await scopedDb(read);
      }) satisfies ScopedDb;
      const live = createChatRunLog({ ...options, db: observedDb });
      const controller = new AbortController();
      const liveEntries = live.read("now", controller.signal);
      const iterator = liveEntries[Symbol.asyncIterator]();
      const first = iterator.next();
      await ready.promise;
      const payload = `{"document":"${"x".repeat(bytes)}${secret}","decisionId":"${decisionId}"}`;
      const split = payload.length - 20;
      const chunks = [
        ...(kind === "tool"
          ? ([
              {
                type: EventType.TOOL_CALL_START,
                toolCallId: "document",
                toolCallName: "draft",
                parentMessageId: assistantId,
              },
            ] satisfies StreamChunk[])
          : ([
              {
                type: EventType.CUSTOM,
                name: "structured-output.start",
                value: { messageId: assistantId },
              },
            ] satisfies StreamChunk[])),
        ...(kind === "tool"
          ? ([
              {
                type: EventType.TOOL_CALL_ARGS,
                toolCallId: "document",
                delta: payload.slice(0, 16),
              },
              {
                type: EventType.TOOL_CALL_ARGS,
                toolCallId: "document",
                delta: payload.slice(16, split),
              },
              {
                type: EventType.TOOL_CALL_ARGS,
                toolCallId: "document",
                delta: payload.slice(split),
              },
              { type: EventType.TOOL_CALL_END, toolCallId: "document" },
            ] satisfies StreamChunk[])
          : ([
              {
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId: assistantId,
                delta: payload.slice(0, 16),
              },
              {
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId: assistantId,
                delta: payload.slice(16, split),
              },
              {
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId: assistantId,
                delta: payload.slice(split),
              },
            ] satisfies StreamChunk[])),
      ];
      try {
        await writer.append(chunks.slice(0, 2));
        const delivered = [await first, await iterator.next()];
        for (const chunk of chunks.slice(2)) {
          const pending = iterator.next();
          await writer.append([chunk]);
          delivered.push(await pending);
        }
        expect(delivered.map((entry) => entry.value?.chunk)).toEqual(chunks);
        const state = await referenceSummary();
        expect(state?.type).toBe("rescan-required");
        expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThan(1024);
        expect(JSON.stringify(state)).not.toContain(secret);
        await writer.close();
        expect((await iterator.next()).done).toBe(true);
        const replay = await request(async () => await writer.snapshot());
        expect(JSON.stringify(replay)).toContain(marker);
        expect(JSON.stringify(replay)).not.toContain(secret);
      } finally {
        controller.abort();
        await iterator.return?.();
        await writer.close();
      }
    },
  );

  test("reference reconstruction fallback preserves the existing run byte ceiling", async () => {
    const { writer, options } = await liveLogFixture("generic");
    await writer.append([
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "large-document",
        role: "assistant",
      },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "document",
        toolCallName: "draft",
        parentMessageId: "large-document",
      },
    ]);
    const before = await scopedDb(
      async (tx) =>
        await tx
          .update(chatRunLogs)
          .set({ bytesUsed: BigInt(MAX_RUN_BYTES) })
          .where(eq(chatRunLogs.runId, options.runId))
          .returning({
            nextSeq: chatRunLogs.nextSeq,
            state: chatRunLogs.referenceSummary,
          }),
    );
    expect(before.at(0)?.state.type).toBe("rescan-required");
    const append = await Result.tryPromise(
      async () =>
        await writer.append([
          {
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: "document",
            delta: "{}",
          },
        ]),
    );
    expect(append.isErr()).toBe(true);
    if (append.isErr()) {
      expect(append.error.cause).toMatchObject({
        message: "Chat run log exceeds its size limit",
      });
    }
    const after = await scopedDb(
      async (tx) =>
        await tx
          .select({ nextSeq: chatRunLogs.nextSeq })
          .from(chatRunLogs)
          .where(eq(chatRunLogs.runId, options.runId))
          .limit(1),
    );
    expect(after.at(0)?.nextSeq).toBe(before.at(0)?.nextSeq);
    await writer.close();
  });

  test("reference summary overflow defers reconstruction and preserves append delivery", async () => {
    const { writer, options } = await liveLogFixture("generic");
    await writer.append([
      { type: EventType.RUN_STARTED, runId: options.runId, threadId },
    ]);
    const header = async () =>
      await scopedDb(
        async (tx) =>
          await tx
            .select({
              bytes: chatRunLogs.bytesUsed,
              nextSeq: chatRunLogs.nextSeq,
              state: chatRunLogs.referenceSummary,
            })
            .from(chatRunLogs)
            .where(eq(chatRunLogs.runId, options.runId))
            .limit(1),
      );
    const before = await header();
    const result = await Result.tryPromise(
      async () =>
        await writer.append([
          {
            type: EventType.CUSTOM,
            name: "references",
            value: {
              decisionIds: Array.from({ length: 900 }, () =>
                createSafeId<"caseLawDecision">(),
              ),
            },
          },
        ]),
    );
    expect(result.isOk()).toBe(true);
    const after = await header();
    expect(after.at(0)?.nextSeq).toBe((before.at(0)?.nextSeq ?? 0n) + 1n);
    expect(after.at(0)?.state).toMatchObject({ type: "rescan-required" });
    await writer.close();
  });

  test("a persisted checkpoint gap is refused on read and repaired by the next append", async () => {
    const { writer, options } = await liveLogFixture("generic");
    await writer.append([
      { type: EventType.RUN_STARTED, runId: options.runId, threadId },
    ]);
    await scopedDb(
      async (tx) =>
        await tx
          .update(chatRunLogs)
          .set({
            referenceSummary: {
              type: "checkpointed",
              through: "0",
              decisionIds: [],
              messages: [],
            },
          })
          .where(eq(chatRunLogs.runId, options.runId)),
    );
    const replay = await Result.tryPromise(async () => await writer.snapshot());
    expect(replay.isErr()).toBe(true);
    if (replay.isErr()) {
      expect(replay.error.cause).toMatchObject({
        message: "Chat run log reference summary is incomplete",
      });
    }
    const append = await Result.tryPromise(
      async () =>
        await writer.append([
          { type: EventType.RUN_STARTED, runId: options.runId, threadId },
        ]),
    );
    expect(append.isOk()).toBe(true);
    const repaired = await Result.tryPromise(
      async () => await writer.snapshot(),
    );
    expect(repaired.isOk()).toBe(true);
    await writer.close();
  });

  test.each(["withdrawn", "active"] as const)(
    "split structured tool input retains its source reference (%s)",
    async (source) => {
      const { writer } = await liveLogFixture("generic");
      const assistantId = createSafeId<"chatMessage">();
      const id = source === "withdrawn" ? decisionId : activeId;
      await writer.append([
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: assistantId,
          role: "assistant",
        },
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "source",
          toolCallName: "read-decision",
          parentMessageId: assistantId,
        },
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: "source",
          delta: `{"context":"${"x".repeat(2048)}","decisionId":"${id.slice(0, 10)}`,
        },
      ]);
      await writer.append([
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: "source",
          delta: `${id.slice(10)}"}`,
        },
        { type: EventType.TOOL_CALL_END, toolCallId: "source" },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: assistantId,
          delta: secret,
        },
        { type: EventType.TEXT_MESSAGE_END, messageId: assistantId },
      ]);
      await writer.close();
      const snapshot = await request(async () => await writer.snapshot());
      if (source === "withdrawn") {
        expect(JSON.stringify(snapshot)).toContain(marker);
        expect(JSON.stringify(snapshot)).not.toContain(secret);
      } else {
        expect(JSON.stringify(snapshot)).toContain(secret);
        expect(JSON.stringify(snapshot)).not.toContain(marker);
      }
    },
  );

  test.each(["thinking", "activity"] as const)(
    "persisted replay preserves %s references across appends",
    async (kind) => {
      const { writer } = await liveLogFixture("generic");
      const assistantId = createSafeId<"chatMessage">();
      await writer.append([
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: assistantId,
          role: "assistant",
        },
        ...(kind === "thinking"
          ? ([
              {
                type: EventType.REASONING_MESSAGE_CONTENT,
                messageId: "reasoning",
                delta: `[decision](#stella-decision=${decisionId.slice(0, 10)}`,
              },
            ] satisfies StreamChunk[])
          : ([
              {
                type: "ACTIVITY_SNAPSHOT",
                messageId: "progress",
                activityType: "research",
                content: { decisionId: null },
              },
            ] satisfies StreamChunk[])),
      ]);
      await writer.append([
        ...(kind === "thinking"
          ? ([
              {
                type: EventType.REASONING_MESSAGE_CONTENT,
                messageId: "reasoning",
                delta: `${decisionId.slice(10)})`,
              },
            ] satisfies StreamChunk[])
          : ([
              {
                type: "ACTIVITY_DELTA",
                messageId: "progress",
                activityType: "research",
                patch: [
                  { op: "replace", path: "/decisionId", value: decisionId },
                ],
              },
            ] satisfies StreamChunk[])),
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: assistantId,
          delta: secret,
        },
        { type: EventType.TEXT_MESSAGE_END, messageId: assistantId },
      ]);
      await writer.close();
      const snapshot = await request(async () => await writer.snapshot());
      expect(JSON.stringify(snapshot)).toContain(marker);
      expect(JSON.stringify(snapshot)).not.toContain(secret);
    },
  );

  test("persisted replay retains structured references when a stream ends early", async () => {
    const { writer } = await liveLogFixture("generic");
    const assistantId = createSafeId<"chatMessage">();
    await writer.append([
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: assistantId,
        role: "assistant",
      },
      {
        type: EventType.CUSTOM,
        name: "structured-output.start",
        value: { messageId: assistantId },
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: assistantId,
        delta: `{"decisionId":"${decisionId.slice(0, 10)}`,
      },
    ]);
    await writer.append([
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: assistantId,
        delta: `${decisionId.slice(10)}","summary":"${secret}"}`,
      },
      { type: EventType.RUN_ERROR, message: "Stopped" },
    ]);
    await writer.close();
    const snapshot = await request(async () => await writer.snapshot());
    expect(JSON.stringify(snapshot)).toContain(marker);
    expect(JSON.stringify(snapshot)).not.toContain(secret);
  });

  test("a nonempty pre-migration log replays and appends through paged legacy reads", async () => {
    await withGatedTestClients(
      process.env["DATABASE_URL"] ??
        panic("Postgres fixture requires DATABASE_URL"),
      async ({ openClient }) => {
        const queries: { query: string; params: unknown[] }[] = [];
        const client = openClient({
          logger: {
            logQuery: (query, params) => {
              queries.push({ query, params });
            },
          },
        });
        const namespace = sql.identifier(
          `legacy_logs_${Bun.randomUUIDv7().replaceAll("-", "")}`,
        );
        const { options } = await liveLogFixture("generic");
        const assistantId = createSafeId<"chatMessage">();
        const chunks = [
          {
            type: EventType.TEXT_MESSAGE_START,
            messageId: assistantId,
            role: "assistant",
          },
          {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: assistantId,
            delta: secret,
          },
          ...Array.from(
            { length: 600 },
            () =>
              ({
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId: assistantId,
                delta: "x".repeat(1024),
              }) as const,
          ),
          {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: assistantId,
            delta: `[decision](#stella-decision=${decisionId})`,
          },
          { type: EventType.TEXT_MESSAGE_END, messageId: assistantId },
        ] satisfies StreamChunk[];
        const bytes = chunks.reduce(
          (sum, chunk) => sum + Buffer.byteLength(JSON.stringify(chunk)),
          0,
        );
        const batchId = Bun.randomUUIDv7();
        const migration = await Bun.file(
          new URL(
            "../../../drizzle/20261029140600_chat_run_reference_state/migration.sql",
            import.meta.url,
          ),
        ).text();
        await client.db.execute(sql`CREATE SCHEMA ${namespace}`);
        try {
          await client.db.transaction(async (tx) => {
            await tx.execute(
              sql`SET LOCAL search_path TO ${namespace}, public`,
            );
            await tx.execute(
              sql`CREATE TABLE chat_run_logs (LIKE public.chat_run_logs INCLUDING ALL)`,
            );
            await tx.execute(
              sql`ALTER TABLE ${namespace}.chat_run_logs DROP COLUMN reference_summary`,
            );
            await tx.execute(
              sql`CREATE TABLE chat_run_log_entries (LIKE public.chat_run_log_entries INCLUDING ALL)`,
            );
            await tx.execute(
              sql`INSERT INTO chat_run_logs (organization_id, run_id, turn_id, next_seq, bytes_used) VALUES (${organizationId}, ${options.runId}, ${options.execution.id}, ${chunks.length + 1}, ${bytes})`,
            );
            await tx.execute(
              sql`INSERT INTO chat_run_log_entries (organization_id, run_id, seq, batch_id, batch_index, chunk) VALUES ${sql.join(
                chunks.map(
                  (chunk, index) =>
                    sql`(${organizationId}, ${options.runId}, ${index + 1}, ${batchId}, ${index}, ${JSON.stringify(chunk)}::text::jsonb)`,
                ),
                sql`, `,
              )}`,
            );
            for (const statement of migration
              .split(";")
              .map((part) => part.trim())
              .filter((part) => part !== "")) {
              // db-await-in-loop: four statements from the reviewed migration, applied to this test's isolated old-schema tables
              await tx.execute(sql.raw(statement));
            }
          });
          await client.db.execute(
            sql`GRANT USAGE ON SCHEMA ${namespace} TO stella`,
          );
          await client.db.execute(
            sql`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${namespace} TO stella`,
          );
          const scoped = createScopedDb(
            markRlsDatabase(client.db),
            [workspaceId],
            organizationId,
            userId,
          );
          const legacyDb = (async (read) =>
            await scoped(async (tx) => {
              await tx.execute(
                sql`SET LOCAL search_path TO ${namespace}, public`,
              );
              return await read(tx);
            })) satisfies ScopedDb;
          const log = createChatRunLog({ ...options, db: legacyDb });
          queries.length = 0;
          const replay =
            (await createChatRunLogReplay({
              db: legacyDb,
              organizationId,
              runId: options.runId,
              resumeOffset: "-1",
            })) ?? panic("Expected legacy replay");
          const iterator = replay.read("-1")[Symbol.asyncIterator]();
          const first = await request(async () => await iterator.next());
          await iterator.return?.();
          expect(first.done).toBe(false);
          expect(JSON.stringify(first)).toContain(marker);
          expect(JSON.stringify(first)).not.toContain(secret);
          const pages = queries.filter(({ query }) =>
            query.includes('from "chat_run_log_entries"'),
          );
          expect(pages.length).toBeGreaterThan(1);
          expect(
            pages.every(
              ({ query, params }) =>
                /limit \$\d+/u.test(query) && params.at(-1) === READ_PAGE_SIZE,
            ),
          ).toBe(true);
          expect(
            queries.every(({ query }) => !query.includes("jsonb_agg")),
          ).toBe(true);
          // A legacy producer can continue a large partial input without adopting
          // the new summary budget halfway through its run.
          await log.append([
            {
              type: EventType.TEXT_MESSAGE_START,
              messageId: "continuation",
              role: "assistant",
            },
            {
              type: EventType.TOOL_CALL_START,
              toolCallId: "document",
              toolCallName: "draft",
              parentMessageId: "continuation",
            },
            {
              type: EventType.TOOL_CALL_ARGS,
              toolCallId: "document",
              delta: `{"body":"${"x".repeat(40 * 1024)}`,
            },
            {
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId: "continuation",
              delta: secret,
            },
          ]);
          const state = await legacyDb(
            async (tx) =>
              await tx
                .select({ state: chatRunLogs.referenceSummary })
                .from(chatRunLogs)
                .where(eq(chatRunLogs.runId, options.runId))
                .limit(1),
          );
          expect(state.at(0)?.state).toEqual({ type: "legacy" });
          await log.close();
          const delivered = await request(async () => {
            const result = [];
            for await (const entry of log.read("-1")) {
              result.push(entry);
            }
            return result;
          });
          expect(delivered).toHaveLength(chunks.length + 4);
          expect(JSON.stringify(delivered)).toContain(marker);
          expect(JSON.stringify(delivered)).not.toContain(secret);
          await legacyDb(
            async (tx) =>
              await tx
                .update(chatRunLogs)
                .set({ bytesUsed: BigInt(MAX_RUN_BYTES) + 1n })
                .where(eq(chatRunLogs.runId, options.runId)),
          );
          const oversized = await Result.tryPromise(
            async () => await log.snapshot(),
          );
          expect(oversized.isErr()).toBe(true);
          if (oversized.isErr()) {
            expect(oversized.error.cause).toMatchObject({
              message: "Chat run log exceeds its size limit",
            });
          }
          const fresh = await liveLogFixture("generic");
          const freshLog = createChatRunLog({ ...fresh.options, db: legacyDb });
          await freshLog.append([
            {
              type: EventType.RUN_STARTED,
              runId: fresh.options.runId,
              threadId,
            },
          ]);
          const freshState = await legacyDb(
            async (tx) =>
              await tx
                .select({ state: chatRunLogs.referenceSummary })
                .from(chatRunLogs)
                .where(eq(chatRunLogs.runId, fresh.options.runId))
                .limit(1),
          );
          expect(freshState.at(0)?.state.type).toBe("checkpointed");
          await freshLog.close();
        } finally {
          await client.db.execute(sql`DROP SCHEMA ${namespace} CASCADE`);
        }
      },
    );
  });

  test("new explicit run sources are checked before replaying a later batch", async () => {
    const id = createSafeId<"chatThread">();
    const incomingId = createSafeId<"chatMessage">();
    const execution = {
      id: createSafeId<"chatTurn">(),
      executionId: Bun.randomUUIDv7(),
    };
    const laterRunId = Bun.randomUUIDv7();
    seededThreads.push(id);
    await scopedDb(async (tx) => {
      await tx.insert(chatThreads).values({
        id,
        organizationId,
        userId,
        workspaceId,
        title: own,
        titleSource: "user",
      });
      await tx.insert(chatMessages).values({
        id: incomingId,
        threadId: id,
        userId,
        workspaceId,
        role: "user",
        content: ownContent,
      });
      await tx.insert(chatTurns).values({
        id: execution.id,
        executionId: execution.executionId,
        organizationId,
        userId,
        workspaceId,
        threadId: id,
        userMessageId: incomingId,
        runId: laterRunId,
        status: "running",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      });
    });
    const log = createChatRunLog({
      db: scopedDb,
      organizationId,
      runId: laterRunId,
      execution,
    });
    await log.append([
      { type: EventType.RUN_STARTED, runId: laterRunId, threadId: id },
    ]);
    await request(async () => await log.snapshot());
    await log.append([
      { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta: `${secret} [decision](#stella-decision=${decisionId})`,
      },
      { type: EventType.TEXT_MESSAGE_END, messageId },
      { type: EventType.RUN_FINISHED, runId: laterRunId, threadId: id },
    ]);
    const checked = await request(async () => await log.snapshot());
    expect(JSON.stringify(checked)).toContain(marker);
    expect(JSON.stringify(checked)).not.toContain(secret);
  });

  test("active decision context remains readable and authored titles survive withdrawal", async () => {
    const active = (
      await request(async () =>
        loadWindowedThreadMessages({ safeDb, threadId: activeThreadId }),
      )
    ).unwrap();
    expect(JSON.stringify(active)).toContain(secret);
    expect(JSON.stringify(active)).not.toContain(marker);
    await scopedDb((tx) =>
      tx
        .update(chatThreads)
        .set({ title: own, titleSource: "user" })
        .where(eq(chatThreads.id, threadId)),
    );
    const source = (
      await request(async () =>
        readChatExportSource({ safeDb, threadId, messageId, userId }),
      )
    ).unwrap();
    expect(source?.title).toBe(own);
    expect(JSON.stringify(source?.messages)).toContain(marker);
    expect(JSON.stringify(source)).not.toContain(secret);
  });

  test("10 and 100 distinct source identities have the same read cost and projected response size", async () => {
    const measurements: { statements: number; bytes: number }[] = [];
    for (const size of [10, 100]) {
      const id = createSafeId<"chatThread">();
      seededThreads.push(id);
      const refs = [
        decisionId,
        ...Array.from({ length: size - 1 }, () =>
          createSafeId<"caseLawDecision">(),
        ),
      ];
      await scopedDb(async (tx) => {
        await tx.insert(chatThreads).values({
          id,
          organizationId,
          userId,
          workspaceId,
          title: own,
          titleSource: "user",
        });
        await tx.insert(chatMessages).values({
          id: createSafeId<"chatMessage">(),
          threadId: id,
          userId,
          workspaceId,
          role: "assistant",
          content: proveTextOnlyPersistedChatMessageContent({
            version: 3,
            data: [
              {
                type: "text",
                content: refs
                  .map((ref) => `[decision](#stella-decision=${ref})`)
                  .join(" "),
              },
            ],
          }),
        });
      });
      await request(
        async () =>
          await runWithQueryCounter(
            async (counter) => {
              const page = (
                await loadChatMessagePage({ safeDb, threadId: id, userId })
              ).unwrap();
              expect(JSON.stringify(page)).toContain(marker);
              const lookups = [...counter.fingerprints]
                .filter(([key]) =>
                  key.includes('from "case_law_withdrawal_status"'),
                )
                .reduce((total, [, count]) => total + count, 0);
              expect(lookups).toBe(1);
              measurements.push({
                statements: counter.count,
                bytes: JSON.stringify(page).length,
              });
            },
            { detectRepeatedQueries: true },
          ),
      );
    }
    expect(measurements.at(0)).toEqual(measurements.at(1));
  });
});
