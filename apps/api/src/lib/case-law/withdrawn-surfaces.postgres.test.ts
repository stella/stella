import { EventType } from "@tanstack/ai";
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
  chatMessageRevisions,
  chatMessages,
  chatMessageSearchDocuments,
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
import { readChatExportSource } from "@/api/lib/chat/export-source";
import { proveTextOnlyPersistedChatMessageContent } from "@/api/lib/chat/persisted-message-content";
import { createChatRunLog } from "@/api/lib/chat/run-log";
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
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
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
      .where(inArray(caseLawIndexJobs.decisionId, [decisionId, activeId]));
    await db
      .delete(caseLawDecisions)
      .where(inArray(caseLawDecisions.id, [decisionId, activeId]));
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
        return { chatRunLogEntries: entries };
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
