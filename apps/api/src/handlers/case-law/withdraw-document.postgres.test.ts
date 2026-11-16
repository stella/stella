/**
 * Withdrawal and redaction against the schema the migrations build, where the
 * redaction fence trigger is installed; schema push leaves it out. A withdrawal
 * keeps the row, a redaction tombstones it, and a historically redacted payload
 * still cannot be written back.
 *
 * Runs in the Postgres job; skipped elsewhere.
 */
import { describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawDecisions,
  caseLawIndexJobs,
  caseLawSources,
} from "@/api/db/schema";
import { redactCaseLawDecision } from "@/api/handlers/case-law/erasure";
import { withdrawCaseLawDecisionDocument } from "@/api/handlers/case-law/withdraw-document";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgresTests) {
  describe.skip("case-law withdrawal and redaction (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("case-law withdrawal and redaction (postgres)", () => {
    const { db, cleanUp } = openGatedTestDatabase(databaseUrl);
    const sourceId = createSafeId<"caseLawSource">();
    const decisionIds: SafeId<"caseLawDecision">[] = [];
    const scopedDb = asTestRaw<ScopedDb>(
      async (callback: (tx: typeof db) => Promise<unknown>) =>
        await db.transaction(async (tx) => await callback(asTestRaw(tx))),
    );

    cleanUp(async () => {
      if (decisionIds.length > 0) {
        await db
          .delete(caseLawIndexJobs)
          .where(inArray(caseLawIndexJobs.decisionId, decisionIds));
        await db
          .delete(caseLawDecisions)
          .where(inArray(caseLawDecisions.id, decisionIds));
      }
      await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
    });

    const seedDecision = async () => {
      if (decisionIds.length === 0) {
        await db.insert(caseLawSources).values({
          id: sourceId,
          adapterKey: `withdrawal-fence-${sourceId}`,
          name: "Withdrawal fence fixture",
          enabled: false,
        });
      }
      const id = createSafeId<"caseLawDecision">();
      decisionIds.push(id);
      await db.insert(caseLawDecisions).values({
        id,
        sourceId,
        sourceDocumentId: `withdrawal-fence-${id}`,
        country: "POL",
        court: "Withdrawal fence fixture court",
        language: "pl",
        caseNumber: `withdrawal-fence-${id}`,
        fulltext: "stored payload",
        contentHash: "stored-payload-hash",
      });
      return id;
    };

    const readRow = async (id: SafeId<"caseLawDecision">) =>
      (
        await db
          .select({
            redactedAt: caseLawDecisions.redactedAt,
            fulltext: caseLawDecisions.fulltext,
            contentHash: caseLawDecisions.contentHash,
          })
          .from(caseLawDecisions)
          .where(eq(caseLawDecisions.id, id))
      ).at(0);

    test("a withdrawal takes the document back and keeps the row", async () => {
      const id = await seedDecision();

      const outcome = await withdrawCaseLawDecisionDocument({
        decisionId: id,
        reason: "stored payload is not a document",
        scopedDb,
      });

      expect(outcome.isOk() && outcome.value).toEqual({ type: "withdrawn" });
      expect(await readRow(id)).toEqual({
        redactedAt: null,
        fulltext: null,
        contentHash: null,
      });
      const audits = await db
        .select({ operation: caseLawIndexJobs.operation })
        .from(caseLawIndexJobs)
        .where(eq(caseLawIndexJobs.decisionId, id));
      expect(audits.map(({ operation }) => operation)).toEqual(["withdraw"]);
    });

    test("a redaction still tombstones the row", async () => {
      const id = await seedDecision();

      const outcome = await redactCaseLawDecision({
        decisionId: id,
        scopedDb,
        sweepRaw: async () => ({ type: "swept", legacy: "none" }),
      });

      expect(outcome.isOk()).toBe(true);
      const row = await readRow(id);
      expect(row?.redactedAt).toBeInstanceOf(Date);
      expect(row?.fulltext).toBeNull();
    });

    test("a historically redacted payload cannot be written back", async () => {
      const id = await seedDecision();
      await db.insert(caseLawIndexJobs).values({
        decisionId: id,
        operation: "redact",
        status: "failed",
        contentHash: null,
        errorMessage: "historical redaction audit",
      });

      const refused = await db
        .update(caseLawDecisions)
        .set({ fulltext: "restored payload" })
        .where(eq(caseLawDecisions.id, id))
        .then(
          () => null,
          (error: unknown) => error,
        );

      // The driver wraps the server's error; its cause carries the message.
      expect(Bun.inspect(refused)).toContain(
        "cannot restore a historically redacted case-law payload",
      );
      expect((await readRow(id))?.fulltext).toBe("stored payload");
    });
  });
}
