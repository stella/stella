import { panic, Result } from "better-result";
import { beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { rejectionOf } from "@stll/property-testing/rejection";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { safeDbFromScoped } from "@/api/db/safe-db";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawDecisions,
  caseLawSources,
  chatMessages,
  chatThreads,
} from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { redactCaseLawDecision } from "@/api/handlers/case-law/erasure";
import { toPersistedChatMessageContentV3 } from "@/api/handlers/chat/chat-message-parts";
import { generateAdmittedThreadTitle } from "@/api/handlers/chat/generate-thread-title";
import type { ChatMessage } from "@/api/handlers/chat/types";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { WithdrawnCopyProjection } from "@/api/lib/case-law/withdrawn-copy-projection";
import { readWithdrawnCopyProjection } from "@/api/lib/case-law/withdrawn-copy-read";
import { readChatExportSource } from "@/api/lib/chat/export-source";
import { readChatCopyProjection } from "@/api/lib/chat/withdrawn-copies";
import { runWithQueryCounter } from "@/api/lib/db-query-counter";
import { deleteCorpusDocument } from "@/api/lib/legal-search/corpus-storage";
import { upsertChatThreadSearchDocument } from "@/api/lib/search/index-chat";
import { searchGlobal } from "@/api/lib/search/index-global";
import { readSearchPreview } from "@/api/lib/search/preview";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import {
  testModelAdmission,
  testOrganizationStateDb,
} from "@/api/tests/helpers/model-dispatch-admission";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import {
  ARTEFACT_SOURCE_DECISION_LIMIT,
  type ArtefactOrigin,
  authorArtefact,
  generateArtefact,
  readArtefactOrigin,
  readArtefactText,
  writeThreadArtefactTitle,
} from "./generated-artefact-provenance";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
describe.skipIf(!enabled)("generated artefact storage (postgres)", () => {
  const { db, cleanUp } = openGatedTestDatabase(
    process.env["DATABASE_URL"] ??
      panic("Postgres fixture requires DATABASE_URL"),
  );
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const scopedDb = createScopedDb(
    markRlsDatabase(db),
    [],
    organizationId,
    userId,
  );
  const generatedId = createSafeId<"chatThread">();
  const authoredId = createSafeId<"chatThread">();
  const legacyId = createSafeId<"chatThread">();
  const sourceId = createSafeId<"caseLawDecision">();
  const sourceRegistryId = createSafeId<"caseLawSource">();
  const validationId = createSafeId<"chatThread">();
  const foreignOrganizationId = mintAuthProviderId<"organization">();
  const foreignId = createSafeId<"chatThread">();
  const generator = "apps/api/src/handlers/chat/generate-thread-title.ts";
  const projection = new WithdrawnCopyProjection([sourceId], "Unavailable");
  const text = "A generated title without references";
  let audits = 0;
  const recordAuditEvent = async () => {
    audits++;
  };
  const seedPilotDecision = async (id: SafeId<"caseLawDecision">) =>
    await db.insert(caseLawDecisions).values({
      id,
      sourceId: sourceRegistryId,
      sourceDocumentId: id,
      caseNumber: "Title source",
      country: "GBR",
      court: "Fixture",
      language: "en",
      fulltext: "Title source text",
      contentHash: id,
    });
  const withdrawDecision = async (decisionId: SafeId<"caseLawDecision">) =>
    await redactCaseLawDecision({
      decisionId,
      scopedDb: asTestRaw<ScopedDb>(
        async <T>(read: (tx: Transaction) => Promise<T>) =>
          await db.transaction(async (tx) => await read(asTestRaw(tx))),
      ),
      sweepRaw: async () => ({ type: "swept", legacy: "none" }),
      deleteCorpus: async (keys, deletionOptions) =>
        await deleteCorpusDocument(keys, {
          ...deletionOptions,
          deleteObject: async () => undefined,
        }),
    });
  beforeAll(async () => {
    await db.insert(user).values({
      id: userId,
      name: "Provenance",
      email: `${userId}@example.test`,
    });
    await db.insert(organization).values({
      id: organizationId,
      name: "Provenance",
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
    await db.insert(organization).values({
      id: foreignOrganizationId,
      name: "Other organization",
      slug: foreignOrganizationId,
      createdAt: new Date(),
    });
    await db.insert(caseLawSources).values({
      id: sourceRegistryId,
      adapterKey: sourceRegistryId,
      name: "Provenance",
      enabled: false,
    });
    await db.insert(caseLawDecisions).values({
      id: sourceId,
      sourceId: sourceRegistryId,
      sourceDocumentId: sourceId,
      caseNumber: "Fixture",
      country: "POL",
      court: "Fixture",
      language: "pl",
      fulltext: "Fixture source",
      contentHash: "fixture",
    });
    await db.insert(chatThreads).values([
      {
        id: validationId,
        organizationId,
        userId,
        title: "Validation",
        titleSource: "default",
      },
      {
        id: foreignId,
        organizationId: foreignOrganizationId,
        userId,
        title: "Other title",
        titleSource: "default",
      },
      {
        id: generatedId,
        organizationId,
        userId,
        title: "Placeholder",
        titleSource: "default",
      },
      {
        id: authoredId,
        organizationId,
        userId,
        title: "My own title",
        titleSource: "user",
      },
      {
        id: legacyId,
        organizationId,
        userId,
        title: "Legacy",
        titleSource: "ai",
      },
    ]);
  });
  cleanUp(async () => {
    await db
      .delete(chatThreads)
      .where(eq(chatThreads.organizationId, organizationId));
    await db
      .delete(chatThreads)
      .where(eq(chatThreads.organizationId, foreignOrganizationId));
    await db
      .delete(organization)
      .where(eq(organization.id, foreignOrganizationId));
    await db
      .delete(caseLawDecisions)
      .where(eq(caseLawDecisions.sourceId, sourceRegistryId));
    await db
      .delete(caseLawSources)
      .where(eq(caseLawSources.id, sourceRegistryId));
    await db.delete(organization).where(eq(organization.id, organizationId));
    await db.delete(user).where(eq(user.id, userId));
  });
  test("the owned write binds value, origin and source without changing legacy rows", async () => {
    const artefact = (
      await generateArtefact({
        generator,
        sources: { decisionIds: [sourceId], inputs: [] },
        generate: () => text,
      })
    ).unwrap();
    expect(
      await scopedDb(
        async (tx) =>
          await writeThreadArtefactTitle({
            tx,
            threadId: generatedId,
            expected: { title: "Placeholder", source: "default" },
            artefact,
            recordAuditEvent,
          }),
      ),
    ).toBe(true);
    expect(audits).toBe(1);
    const rows = await scopedDb(
      async (tx) =>
        await tx
          .select()
          .from(chatThreads)
          .where(eq(chatThreads.id, generatedId))
          .limit(1),
    );
    const row = rows.at(0) ?? panic("Missing generated fixture");
    expect(row.title).toBe(text);
    expect(row.titleSource).toBe("ai");
    const origin = readArtefactOrigin(row.generationProvenance, "title");
    expect(origin).toEqual({
      type: "generated",
      generator,
      decisionIds: [sourceId],
      coverage: "complete",
    });
    const withdrawn = await withdrawDecision(sourceId);
    expect(withdrawn.isOk()).toBe(true);
    const current = await readWithdrawnCopyProjection({
      values: row.generationProvenance,
      locale: "en",
    });
    expect(
      readArtefactText({ value: row.title, origin, projection: current }),
    ).toBe("Withdrawn by publisher");
    expect(
      readArtefactText({
        value: row.title,
        origin,
        projection: new WithdrawnCopyProjection([], "Unavailable"),
      }),
    ).toBe(text);
    const legacy =
      (
        await db
          .select()
          .from(chatThreads)
          .where(eq(chatThreads.id, legacyId))
          .limit(1)
      ).at(0) ?? panic("Missing legacy fixture");
    expect(legacy.generationProvenance).toBeNull();
    expect(
      readArtefactText({
        value: legacy.title,
        origin: readArtefactOrigin(legacy.generationProvenance, "title"),
        projection,
      }),
    ).toBe("Legacy");
  });
  test("generated writes cannot replace an authored title and authored replacements remain readable", async () => {
    const artefact = (
      await generateArtefact({
        generator,
        sources: { decisionIds: [sourceId], inputs: [] },
        generate: () => text,
      })
    ).unwrap();
    const before = audits;
    expect(
      await scopedDb(
        async (tx) =>
          await writeThreadArtefactTitle({
            tx,
            threadId: authoredId,
            expected: { title: "My own title", source: "user" },
            artefact,
            recordAuditEvent,
          }),
      ),
    ).toBe(false);
    expect(audits).toBe(before);
    expect(
      await scopedDb(
        async (tx) =>
          await writeThreadArtefactTitle({
            tx,
            threadId: authoredId,
            expected: { title: "My own title", source: "user" },
            artefact: authorArtefact("Edited by me"),
            recordAuditEvent,
          }),
      ),
    ).toBe(true);
    const row =
      (
        await db
          .select()
          .from(chatThreads)
          .where(eq(chatThreads.id, authoredId))
          .limit(1)
      ).at(0) ?? panic("Missing authored fixture");
    expect(row.titleSource).toBe("user");
    expect(
      readArtefactText({
        value: row.title,
        origin: readArtefactOrigin(row.generationProvenance, "title"),
        projection,
      }),
    ).toBe("Edited by me");
  });
  test("a failed audit rolls back value and provenance together", async () => {
    const before = (
      await db
        .select()
        .from(chatThreads)
        .where(eq(chatThreads.id, legacyId))
        .limit(1)
    ).at(0);
    expect(
      await rejectionOf(
        scopedDb(
          async (tx) =>
            await writeThreadArtefactTitle({
              tx,
              threadId: legacyId,
              expected: { title: "Legacy", source: "ai" },
              artefact: authorArtefact("Attempt"),
              recordAuditEvent: async () => panic("Fixture audit unavailable"),
            }),
        ),
      ),
    ).toMatchObject({ message: "Fixture audit unavailable" });
    const after = (
      await db
        .select()
        .from(chatThreads)
        .where(eq(chatThreads.id, legacyId))
        .limit(1)
    ).at(0);
    expect(after?.title).toBe(before?.title);
    expect(after?.generationProvenance).toEqual(before?.generationProvenance);
  });
  test("an owned write cannot target another organization", async () => {
    const before = audits;
    const artefact = (
      await generateArtefact({
        generator,
        sources: { decisionIds: [], inputs: [] },
        generate: () => text,
      })
    ).unwrap();
    expect(
      await scopedDb(
        async (tx) =>
          await writeThreadArtefactTitle({
            tx,
            threadId: foreignId,
            expected: { title: "Other title", source: "default" },
            artefact,
            recordAuditEvent,
          }),
      ),
    ).toBe(false);
    expect(audits).toBe(before);
    const row = (
      await db
        .select()
        .from(chatThreads)
        .where(eq(chatThreads.id, foreignId))
        .limit(1)
    ).at(0);
    expect(row?.title).toBe("Other title");
    expect(row?.generationProvenance).toBeNull();
  });
  const validOrigin = {
    type: "generated",
    generator,
    decisionIds: [sourceId],
    coverage: "complete",
  };
  test.each([
    null,
    { version: 1, slots: { title: {} } },
    [validOrigin],
    { version: 1, slots: [{ title: validOrigin }] },
    { version: 1, slots: { title: [validOrigin] } },
    { version: 1, slots: { title: [[validOrigin]] } },
    { version: 1, slots: { title: { type: "authored" } } },
    { version: 1, slots: { title: { type: ["authored"] } } },
    {
      version: 1,
      slots: { title: { ...validOrigin, coverage: "legacy-input" } },
    },
    ...Object.entries(validOrigin).flatMap(([key, valid]) =>
      [valid, [valid], [[valid]], [], null, {}, 0, true, undefined].map(
        (value) => ({
          version: 1,
          slots: { title: { ...validOrigin, [key]: value } },
        }),
      ),
    ),
  ])("deterministic database/runtime provenance parity: %j", async (value) => {
    const decoded = Result.try(() => readArtefactOrigin(value, "title"));
    const constraint =
      getTableConfig(chatThreads).checks.find(
        ({ name }) => name === "chat_threads_generation_provenance_valid",
      ) ?? panic("Missing provenance constraint");
    const schema = await db.execute(
      sql`SELECT ${constraint.value} AS accepted FROM (SELECT ${JSON.stringify(value)}::text::jsonb AS generation_provenance) chat_threads`,
    );
    expect(schema.at(0)?.["accepted"]).toBe(decoded.isOk());
    const stored = await Result.tryPromise(
      async () =>
        await db
          .update(chatThreads)
          .set({
            generationProvenance: sql`${JSON.stringify(value)}::text::jsonb`,
          })
          .where(eq(chatThreads.id, validationId))
          .returning({ provenance: chatThreads.generationProvenance }),
    );
    expect(stored.isOk()).toBe(decoded.isOk());
    if (stored.isOk()) {
      const row = stored.value.at(0) ?? panic("Missing parity fixture");
      expect(readArtefactOrigin(row.provenance, "title")).toEqual(
        decoded.unwrap(),
      );
    }
  });
  test.each(["generated", "renamed", "withdrawn-before-dispatch"])(
    "title pilot captures ingress sources and keeps race guards: %s",
    async (mode) => {
      const threadId = createSafeId<"chatThread">();
      const decisionId = createSafeId<"caseLawDecision">();
      const userMessageId = createSafeId<"chatMessage">();
      const assistantMessageId = createSafeId<"chatMessage">();
      await seedPilotDecision(decisionId);
      await db
        .insert(chatThreads)
        .values({ id: threadId, organizationId, userId, title: "Placeholder" });
      const messages = [
        {
          id: userMessageId,
          role: "user",
          parts: [
            {
              type: "text",
              content: `Authored bronze question [decision](#stella-decision=${decisionId})`,
            },
          ],
        },
        {
          id: assistantMessageId,
          role: "assistant",
          parts: [{ type: "text", content: "An independent explanation" }],
        },
      ] satisfies [ChatMessage, ChatMessage];
      await db.insert(chatMessages).values(
        messages.map((message) => ({
          id: message.id,
          threadId,
          userId,
          role: message.role,
          content: toPersistedChatMessageContentV3({
            data: message.parts,
          }),
        })),
      );
      const withdraw = async () => {
        expect((await withdrawDecision(decisionId)).isOk()).toBe(true);
      };
      if (mode === "withdrawn-before-dispatch") {
        await withdraw();
      }
      let dispatched = 0;
      let indexed = 0;
      let recorded = 0;
      await generateAdmittedThreadTitle({
        initialTitle: "Placeholder",
        messages,
        organizationId,
        userId,
        orgAIConfig: null,
        managedAIResidency: "eu",
        promptCachingEnabled: false,
        organizationStateDb: testOrganizationStateDb,
        safeDb: safeDbFromScoped(scopedDb),
        threadId,
        threadWorkspaceId: null,
        admissionSignal: new AbortController().signal,
        modelAdmission: testModelAdmission(organizationId),
        recordAuditEvent: async () => {
          recorded++;
        },
        indexThread: async () => {
          indexed++;
        },
        generateTextForTask: async ({ prompt }) => {
          dispatched++;
          expect(prompt).toContain(decisionId);
          if (mode === "renamed") {
            await db
              .update(chatThreads)
              .set({ title: "Authored replacement", titleSource: "user" })
              .where(eq(chatThreads.id, threadId));
          }
          return '"pilotquartz judgement"';
        },
      });
      const row =
        (
          await db
            .select()
            .from(chatThreads)
            .where(eq(chatThreads.id, threadId))
            .limit(1)
        ).at(0) ?? panic("Missing title pilot fixture");
      if (mode !== "generated") {
        expect(dispatched).toBe(mode === "renamed" ? 1 : 0);
        expect(indexed).toBe(0);
        expect(recorded).toBe(0);
        expect(row.title).toBe(
          mode === "renamed" ? "Authored replacement" : "Placeholder",
        );
        expect(row.generationProvenance).toBeNull();
        return;
      }
      expect([dispatched, indexed, recorded]).toEqual([1, 1, 1]);
      expect(row.title).toBe("pilotquartz judgement");
      expect(
        readArtefactOrigin(row.generationProvenance, "title"),
      ).toMatchObject({
        type: "generated",
        decisionIds: [decisionId],
        generator,
      });
      // Editing a source message must not erase the title's captured association.
      const retainedUserContent = toPersistedChatMessageContentV3({
        data: [{ type: "text", content: "Authored bronze question" }],
      });
      expect(JSON.stringify(messages)).toContain(decisionId);
      expect(JSON.stringify(retainedUserContent)).not.toContain(decisionId);
      await db
        .update(chatMessages)
        .set({ content: retainedUserContent })
        .where(eq(chatMessages.id, userMessageId));
      await upsertChatThreadSearchDocument(threadId, db);
      const query = {
        organizationId,
        userId,
        accessibleWorkspaceIds: [],
        selectedWorkspaceIds: [],
        types: ["chat"] as const,
        editedByUserIds: [],
        mimeTypes: [],
        limit: 10,
      };
      const search = async (queryText: string) =>
        await searchGlobal(
          { ...query, types: [...query.types], query: queryText },
          { scopedDb },
        );
      expect(
        (await search("pilotquartz")).hits.some(
          (hit) => hit.id === `chat:${threadId}`,
        ),
      ).toBe(true);
      await withdraw();
      const exportSource = (
        await readChatExportSource({
          safeDb: safeDbFromScoped(scopedDb),
          threadId,
          messageId: userMessageId,
          userId,
        })
      ).unwrap();
      expect(exportSource?.title).not.toBe(row.title);
      expect(exportSource?.messages.at(0)?.content).toEqual(
        retainedUserContent,
      );
      expect((await search("pilotquartz")).hits).toEqual([]);
      const retained = await search("bronze -pilotquartz");
      const retainedHit = retained.hits.find(
        (hit) => hit.id === `chat:${threadId}`,
      );
      expect(retainedHit).toBeDefined();
      expect(retainedHit?.title).toBe(exportSource?.title);
      expect(JSON.stringify(retained)).not.toContain(row.title);
      const preview = await readSearchPreview(
        {
          organizationId,
          userId,
          accessibleWorkspaceIds: [],
          resultId: threadId,
          type: "chat",
          query: "pilotquartz",
        },
        scopedDb,
      );
      expect(preview).toEqual({
        type: "plain-text",
        content: exportSource?.title,
      });
    },
  );

  test("title reads keep query and response budgets with unrelated thread growth", async () => {
    const threadId = createSafeId<"chatThread">();
    const budgetDecisionId = createSafeId<"caseLawDecision">();
    await seedPilotDecision(budgetDecisionId);
    expect((await withdrawDecision(budgetDecisionId)).isOk()).toBe(true);
    await db.insert(chatThreads).values({
      id: threadId,
      organizationId,
      userId,
      title: "Measured title",
    });
    const artefact = (
      await generateArtefact({
        generator,
        sources: { decisionIds: [budgetDecisionId], inputs: [] },
        generate: () => "Derived measured title",
      })
    ).unwrap();
    await scopedDb(
      async (tx) =>
        await writeThreadArtefactTitle({
          tx,
          threadId,
          artefact,
          expected: { title: "Measured title", source: "default" },
          recordAuditEvent,
        }),
    );
    const measure = async () =>
      await runWithQueryCounter(async (counter) => {
        const title = await scopedDb(async (tx) => {
          const row =
            (
              await tx
                .select()
                .from(chatThreads)
                .where(eq(chatThreads.id, threadId))
                .limit(1)
            ).at(0) ?? panic("Missing title budget fixture");
          const { projection: titleProjection } = await readChatCopyProjection({
            tx,
            threadIds: [threadId],
            values: row,
          });
          return titleProjection.thread(row).title;
        });
        expect(title).not.toBe("Derived measured title");
        return {
          statements: counter.count,
          transactions: counter.transactions,
          bytes: Buffer.byteLength(JSON.stringify({ title })),
        };
      });
    const insertUnrelated = async (count: number) =>
      await db.insert(chatThreads).values(
        Array.from({ length: count }, () => ({
          id: createSafeId<"chatThread">(),
          organizationId,
          userId,
          title: "Unrelated authored title",
          titleSource: "user" as const,
        })),
      );
    const existing = Number(
      (
        await db
          .select({ count: sql`count(*)` })
          .from(chatThreads)
          .where(eq(chatThreads.organizationId, organizationId))
      ).at(0)?.count,
    );
    expect(existing).toBeLessThan(20);
    await insertUnrelated(20 - existing);
    const small = await measure();
    await insertUnrelated(180);
    const large = await measure();
    expect(small.statements).toBeGreaterThan(0);
    expect(large).toEqual(small);
  });

  test("generated-artefact.storage-validation", async () => {
    const origin = fc.oneof(
      fc.record({ type: fc.constant("authored") }),
      fc.record({
        type: fc.constant("generated"),
        generator: fc.constant(generator),
        decisionIds: fc.array(fc.constantFrom(sourceId, "invalid"), {
          maxLength: 3,
        }),
        coverage: fc.constantFrom("complete", "legacy-input", "unknown"),
      }),
      fc.jsonValue(),
    );
    const envelope = fc.oneof(
      fc.jsonValue(),
      fc.record({
        version: fc.constantFrom(1, 2),
        slots: fc.dictionary(fc.constantFrom("title", "recap", ""), origin, {
          maxKeys: 2,
        }),
      }),
    );
    await assertProperty(
      "generated-artefact.storage-validation",
      fc.asyncProperty(envelope, async (value) => {
        const decoded = Result.try(() => readArtefactOrigin(value, "title"));
        const stored = await Result.tryPromise(
          async () =>
            await db.execute(
              sql`UPDATE chat_threads SET generation_provenance = ${JSON.stringify(value)}::text::jsonb WHERE id = ${validationId}`,
            ),
        );
        expect(stored.isOk()).toBe(decoded.isOk());
      }),
      { numRuns: 50 },
    );
  });
  test("one and ten unrelated threads have the same owned write cost", async () => {
    const id = createSafeId<"chatThread">();
    await db.insert(chatThreads).values({
      id,
      organizationId,
      userId,
      title: "Budget",
      titleSource: "default",
    });
    const measure = async (
      expected: { title: string; source: "default" | "user" },
      value: string,
    ) =>
      await runWithQueryCounter(async (counter) => {
        expect(
          await scopedDb(
            async (tx) =>
              await writeThreadArtefactTitle({
                tx,
                threadId: id,
                expected,
                artefact: authorArtefact(value),
                recordAuditEvent,
              }),
          ),
        ).toBe(true);
        return {
          statements: counter.count,
          transactions: counter.transactions,
        };
      });
    await db.insert(chatThreads).values({
      id: createSafeId<"chatThread">(),
      organizationId,
      userId,
      title: "Unrelated",
      titleSource: "user",
    });
    const small = await measure(
      { title: "Budget", source: "default" },
      "First result",
    );
    await db.insert(chatThreads).values(
      Array.from({ length: 9 }, () => ({
        id: createSafeId<"chatThread">(),
        organizationId,
        userId,
        title: "Unrelated",
        titleSource: "user" as const,
      })),
    );
    const large = await measure(
      { title: "First result", source: "user" },
      "Second result",
    );
    expect(small.statements).toBeGreaterThan(0);
    expect(large).toEqual(small);
  });
  test.each(["null", '{"version":1,"slots":{}}'])(
    "writing a legacy metadata envelope %s records generated origin",
    async (metadata) => {
      const id = createSafeId<"chatThread">();
      await db.insert(chatThreads).values({
        id,
        organizationId,
        userId,
        title: "Legacy envelope",
        titleSource: "default",
      });
      await db.execute(
        sql`UPDATE chat_threads SET generation_provenance = ${metadata}::text::jsonb WHERE id = ${id}`,
      );
      const artefact = (
        await generateArtefact({
          generator,
          sources: { decisionIds: [sourceId], inputs: [] },
          generate: () => text,
        })
      ).unwrap();
      expect(
        await scopedDb(
          async (tx) =>
            await writeThreadArtefactTitle({
              tx,
              threadId: id,
              expected: { title: "Legacy envelope", source: "default" },
              artefact,
              recordAuditEvent,
            }),
        ),
      ).toBe(true);
      const row =
        (
          await db
            .select()
            .from(chatThreads)
            .where(eq(chatThreads.id, id))
            .limit(1)
        ).at(0) ?? panic("Missing legacy envelope fixture");
      expect(
        readArtefactText({
          value: row.title,
          origin: readArtefactOrigin(row.generationProvenance, "title"),
          projection,
        }),
      ).toBe("Unavailable");
    },
  );
  test("one value update preserves the other value's provenance", async () => {
    const recap = {
      type: "generated",
      generator,
      decisionIds: [sourceId],
      coverage: "complete",
    } satisfies ArtefactOrigin;
    await db.execute(
      sql`UPDATE chat_threads SET generation_provenance = ${JSON.stringify({ version: 1, slots: { recap } })}::text::jsonb WHERE id = ${validationId}`,
    );
    expect(
      await scopedDb(
        async (tx) =>
          await writeThreadArtefactTitle({
            tx,
            threadId: validationId,
            expected: { title: "Validation", source: "default" },
            artefact: authorArtefact("My independent title"),
            recordAuditEvent,
          }),
      ),
    ).toBe(true);
    const row =
      (
        await db
          .select()
          .from(chatThreads)
          .where(eq(chatThreads.id, validationId))
          .limit(1)
      ).at(0) ?? panic("Missing validation fixture");
    expect(readArtefactOrigin(row.generationProvenance, "recap")).toEqual(
      recap,
    );
    expect(readArtefactOrigin(row.generationProvenance, "title")).toEqual({
      type: "authored",
    });
    expect(
      readArtefactText({
        value: row.title,
        origin: readArtefactOrigin(row.generationProvenance, "title"),
        projection,
      }),
    ).toBe("My independent title");
  });
  test("PostgreSQL and the runtime share the source-count boundary", async () => {
    const slots = {
      title: {
        type: "generated",
        generator,
        decisionIds: Array.from(
          { length: ARTEFACT_SOURCE_DECISION_LIMIT },
          () => sourceId,
        ),
        coverage: "complete",
      },
    };
    const value = { version: 1, slots };
    await db.execute(
      sql`UPDATE chat_threads SET generation_provenance = ${JSON.stringify(value)}::text::jsonb WHERE id = ${validationId}`,
    );
    expect(readArtefactOrigin(value, "title").type).toBe("generated");
    slots.title.decisionIds.push(sourceId);
    expect(() => readArtefactOrigin(value, "title")).toThrow(
      "Invalid stored artefact provenance",
    );
    expect(
      await rejectionOf(
        db.execute(
          sql`UPDATE chat_threads SET generation_provenance = ${JSON.stringify(value)}::text::jsonb WHERE id = ${validationId}`,
        ),
      ),
    ).toMatchObject({
      cause: { constraint: "chat_threads_generation_provenance_valid" },
    });
  });
  test.each([
    { version: 1, slots: { title: {} } },
    { version: 2, slots: {} },
    {
      version: 1,
      slots: {
        title: {
          type: "generated",
          generator,
          decisionIds: ["invalid"],
          coverage: "complete",
        },
      },
    },
    {
      version: 1,
      slots: {
        title: {
          type: "generated",
          generator,
          decisionIds: [],
          coverage: "unknown",
        },
      },
    },
  ])("PostgreSQL rejects an invalid recorded origin %j", async (value) => {
    expect(
      await rejectionOf(
        db.execute(
          sql`UPDATE chat_threads SET generation_provenance = ${JSON.stringify(value)}::text::jsonb WHERE id = ${legacyId}`,
        ),
      ),
    ).toMatchObject({
      cause: { constraint: "chat_threads_generation_provenance_valid" },
    });
  });
});
