import { panic, Result } from "better-result";
import { beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { rejectionOf } from "@stll/property-testing/rejection";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions, caseLawSources, chatThreads } from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { redactCaseLawDecision } from "@/api/handlers/case-law/erasure";
import { createSafeId } from "@/api/lib/branded-types";
import { WithdrawnCopyProjection } from "@/api/lib/case-law/withdrawn-copy-projection";
import { readWithdrawnCopyProjection } from "@/api/lib/case-law/withdrawn-copy-read";
import { runWithQueryCounter } from "@/api/lib/db-query-counter";
import { deleteCorpusDocument } from "@/api/lib/legal-search/corpus-storage";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import {
  ARTEFACT_SOURCE_DECISION_LIMIT,
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
    await db.delete(caseLawDecisions).where(eq(caseLawDecisions.id, sourceId));
    await db
      .delete(caseLawSources)
      .where(eq(caseLawSources.id, sourceRegistryId));
    await db.delete(organization).where(eq(organization.id, organizationId));
    await db.delete(user).where(eq(user.id, userId));
  });
  test("the owned write binds value, origin and source without changing legacy rows", async () => {
    const artefact = await generateArtefact({
      generator,
      sources: { decisionIds: [sourceId], inputs: [] },
      generate: () => text,
    });
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
    const withdrawn = await redactCaseLawDecision({
      decisionId: sourceId,
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
    const artefact = await generateArtefact({
      generator,
      sources: { decisionIds: [sourceId], inputs: [] },
      generate: () => text,
    });
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
    const artefact = await generateArtefact({
      generator,
      sources: { decisionIds: [], inputs: [] },
      generate: () => text,
    });
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
      const artefact = await generateArtefact({
        generator,
        sources: { decisionIds: [sourceId], inputs: [] },
        generate: () => text,
      });
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
    } as const;
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
