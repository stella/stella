import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import { organization, user } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawDecisions,
  caseLawIndexJobs,
  caseLawSources,
  legalReaderAnnotations,
} from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { redactCaseLawDecision } from "@/api/handlers/case-law/erasure";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { deleteCorpusDocument } from "@/api/lib/legal-search/corpus-storage";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import {
  CaseLawWithdrawalReadError,
  readWithdrawnCopies,
} from "./withdrawn-copies";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)("withdrawn copies (postgres)", () => {
  const url =
    process.env["DATABASE_URL"] ??
    panic("Withdrawal tests require DATABASE_URL");
  const { db, cleanUp } = openGatedTestDatabase(url);
  const sourceId = createSafeId<"caseLawSource">();
  const ids = [
    createSafeId<"caseLawDecision">(),
    createSafeId<"caseLawDecision">(),
    createSafeId<"caseLawDecision">(),
  ];
  const orgId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const tenantDb = createScopedDb(markRlsDatabase(db), [], orgId, userId);
  const annotationId = createSafeId<"legalReaderAnnotation">();
  const scopedDb = asTestRaw<ScopedDb>(
    async (read: (tx: typeof db) => Promise<unknown>) =>
      await db.transaction(async (tx) => await read(asTestRaw(tx))),
  );
  let lookups = 0;
  const reader = asTestRaw<CaseLawPublicReadDb>(
    async <T>(read: (tx: CaseLawPublicReadTransaction) => Promise<T>) => {
      lookups++;
      return await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE stella_public_law_reader`);
        return await read(tx);
      });
    },
  );

  cleanUp(async () => {
    await tenantDb((tx) =>
      tx
        .delete(legalReaderAnnotations)
        .where(eq(legalReaderAnnotations.id, annotationId)),
    );
    await db
      .delete(caseLawIndexJobs)
      .where(inArray(caseLawIndexJobs.decisionId, ids));
    await db.delete(caseLawDecisions).where(inArray(caseLawDecisions.id, ids));
    await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
    await db.delete(organization).where(eq(organization.id, orgId));
    await db.delete(user).where(eq(user.id, userId));
  });

  test("canonical redaction covers inline and standalone documents without changing tenant copies", async () => {
    const [inline, standalone, active] = ids;
    if (
      inline === undefined ||
      standalone === undefined ||
      active === undefined
    ) {
      panic("Withdrawal fixture requires three decisions");
    }
    await db.insert(user).values({
      id: userId,
      name: "Reader",
      email: `${userId}@example.test`,
      emailVerified: true,
    });
    await db.insert(organization).values({
      id: orgId,
      name: "Reader organization",
      slug: orgId,
      createdAt: new Date(),
    });
    await db.insert(caseLawSources).values({
      id: sourceId,
      adapterKey: `withdrawal-${sourceId}`,
      name: "Fixture",
      enabled: false,
    });
    await db.insert(caseLawDecisions).values(
      ids.map((id) => ({
        id,
        sourceId,
        sourceDocumentId: id,
        caseNumber: id,
        court: "Fixture court",
        country: "POL",
        language: "pl",
        fulltext: "Judgment quotation",
        contentHash: "fixture-hash",
        textS3Key: id === standalone ? `corpus/${id}.txt` : null,
      })),
    );
    await tenantDb((tx) =>
      tx.insert(legalReaderAnnotations).values({
        id: annotationId,
        organizationId: orgId,
        userId,
        targetType: "decision",
        targetId: inline,
        kind: "comment",
        blockAnchorId: "p1",
        startOffset: 0,
        endOffset: 18,
        quote: "Judgment quotation",
        body: "My own note",
      }),
    );
    const before = (
      await readWithdrawnCopies({
        values: null,
        decisionIds: ids,
        caseLawDb: reader,
      })
    ).unwrap();
    expect(before.marker(null, inline)).toBeNull();
    for (const decisionId of [inline, standalone]) {
      const redacted = await redactCaseLawDecision({
        decisionId,
        scopedDb,
        sweepRaw: async () => ({ type: "swept", legacy: "none" }),
        deleteCorpus: async (keys, options) =>
          await deleteCorpusDocument(keys, {
            ...options,
            deleteObject: async () => undefined,
          }),
      });
      expect(redacted.isOk()).toBe(true);
    }
    const unknown = createSafeId<"caseLawDecision">();
    for (const size of [10, 100]) {
      lookups = 0;
      const projection = (
        await readWithdrawnCopies({
          values: Array.from({ length: size }, (_, index) => ({
            decisionId:
              index === 0 ? inline : createSafeId<"caseLawDecision">(),
          })),
          decisionIds: [standalone, active, unknown],
          locale: "cs",
          caseLawDb: reader,
        })
      ).unwrap();
      expect(lookups).toBe(1);
      expect(projection.marker(null, inline)).toBe("Staženo vydavatelem");
      expect(projection.marker(null, standalone)).toBe("Staženo vydavatelem");
      expect(projection.marker(null, active)).toBeNull();
      expect(projection.marker(null, unknown)).toBeNull();
      const row =
        (
          await tenantDb((tx) =>
            tx
              .select()
              .from(legalReaderAnnotations)
              .where(eq(legalReaderAnnotations.id, annotationId)),
          )
        ).at(0) ?? panic("Missing annotation fixture");
      expect(projection.annotation(row, inline)).toMatchObject({
        quote: "Staženo vydavatelem",
        body: "My own note",
      });
      expect(row.quote).toBe("Judgment quotation");
    }
    const stored = (
      await tenantDb((tx) =>
        tx
          .select()
          .from(legalReaderAnnotations)
          .where(eq(legalReaderAnnotations.id, annotationId)),
      )
    ).at(0);
    expect(stored?.quote).toBe("Judgment quotation");
    expect(stored?.body).toBe("My own note");
  });

  test("a failed status read is a failure rather than an unknown verdict", async () => {
    const failed = asTestRaw<CaseLawPublicReadDb>(
      async () => await Promise.reject(new TypeError("Fixture read failure")),
    );
    const read = await readWithdrawnCopies({
      values: null,
      decisionIds: ids,
      caseLawDb: failed,
    });
    expect(Result.isError(read)).toBe(true);
    if (read.isErr()) {
      expect(read.error).toBeInstanceOf(CaseLawWithdrawalReadError);
    }
  });
});
