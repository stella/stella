import { panic } from "better-result";
import { beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { rejectionOf } from "@stll/property-testing/rejection";

import { member, organization, user } from "@/api/db/auth-schema";
import { chatThreads } from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import { WithdrawnCopyProjection } from "@/api/lib/case-law/withdrawn-copy-projection";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";

import {
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
  const sourceId = toSafeId<"caseLawDecision">(
    "abcdef01-0000-4000-8000-000000000001",
  );
  const generator = "apps/api/src/handlers/chat/generate-thread-title.ts";
  const projection = new WithdrawnCopyProjection([sourceId], "Unavailable");
  const text = "A generated title without references";
  let audits = 0;
  const recordAuditEvent = async () => {
    audits++;
  };
  beforeAll(async () => {
    await db
      .insert(user)
      .values({
        id: userId,
        name: "Provenance",
        email: `${userId}@example.test`,
      });
    await db
      .insert(organization)
      .values({
        id: organizationId,
        name: "Provenance",
        slug: organizationId,
        createdAt: new Date(),
      });
    await db
      .insert(member)
      .values({
        id: mintAuthProviderIdValue(),
        organizationId,
        userId,
        role: "owner",
        createdAt: new Date(),
      });
    await db.insert(chatThreads).values([
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
    expect(readArtefactText({ value: row.title, origin, projection })).toBe(
      "Unavailable",
    );
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
