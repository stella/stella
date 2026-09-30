import { panic } from "better-result";
/**
 * The read reports whether a decision's document is still to come or is
 * not coming, and only the first may be fetched for the reader. The
 * difference is a NULL text column versus an empty one, which is SQL, so
 * it is tested against Postgres: getting it wrong either strands a
 * fetchable decision or has every view of an unfetchable one take a
 * claim that can never succeed.
 *
 * Runs in the nightly Postgres job; skipped elsewhere.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import {
  caseLawDecisions,
  caseLawSources,
  caseLawTextRetentionVerdicts,
} from "@/api/db/schema";
import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import { readDecisionHandler } from "@/api/handlers/case-law/decisions/get";
import type { SafeId } from "@/api/lib/branded-types";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { withRedistributableSubject } from "@/api/lib/case-law/public-subject";
import { ORACLE_VERSION } from "@/api/lib/legal-search/text-retention/types";
import { EXCLUSION_VERSION } from "@/api/lib/legal-search/text-retention/validation";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgresTests) {
  describe.skip("decision read — document state", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("decision read — document state", () => {
    const { db, cleanUp } = openGatedTestDatabase(databaseUrl);

    let sourceId: SafeId<"caseLawSource">;
    const created: SafeId<"caseLawDecision">[] = [];
    const suffix = Bun.randomUUIDv7().slice(0, 8);

    const insertDecision = async (fulltext: string | null) => {
      const [row] = await db
        .insert(caseLawDecisions)
        .values({
          sourceId,
          caseNumber: `state-${fulltext === null ? "null" : fulltext.length}-${suffix}`,
          court: "Synthetic court",
          country: "CZE",
          language: "cs",
          fulltext,
          documentUrl: "https://example.test/state.pdf",
        })
        .returning({ id: caseLawDecisions.id });
      if (!row) {
        throw new Error("expected decision row");
      }
      created.push(row.id);
      return row.id;
    };

    const readState = async (id: SafeId<"caseLawDecision">) => {
      const subject =
        (await withRedistributableSubject(
          caseLawPublicReadDb,
          {
            kind: "id",
            id,
          },
          async (gated) => gated,
        )) ?? panic("expected a redistributable subject");
      const decision = await readDecisionHandler({ subject });
      if (!("documentPending" in decision)) {
        throw new Error("expected a readable decision");
      }
      return {
        pending: decision.documentPending,
        unavailable: decision.documentUnavailable,
      };
    };

    beforeAll(async () => {
      const existing = await db.query.caseLawSources.findFirst({
        where: { adapterKey: { eq: ADAPTER_KEYS.CZ_REGIONAL } },
        columns: { id: true },
      });
      if (existing) {
        sourceId = existing.id;
        return;
      }
      const [source] = await db
        .insert(caseLawSources)
        .values({
          adapterKey: ADAPTER_KEYS.CZ_REGIONAL,
          name: "Public decision read-state test",
          enabled: false,
        })
        .returning({ id: caseLawSources.id });
      if (!source) {
        throw new Error("expected source row");
      }
      sourceId = source.id;
    });

    cleanUp(async () => {
      if (created.length > 0) {
        await db
          .delete(caseLawDecisions)
          .where(inArray(caseLawDecisions.id, created));
      }
    });

    test("decision detail reads the public verdict and suppresses a superseded pass", async () => {
      const id = await insertDecision("Retained decision text.");
      const fingerprint = "a".repeat(64);
      await db
        .update(caseLawDecisions)
        .set({ contentHash: fingerprint, parserVersion: 7 })
        .where(eq(caseLawDecisions.id, id));
      const readDetail = async () => {
        const detail = await withRedistributableSubject(
          caseLawPublicReadDb,
          { kind: "id", id },
          async (subject) => await readDecisionHandler({ subject }),
        );
        if (detail === null || !("textRetention" in detail)) {
          return panic("Expected readable detail with retention status");
        }
        return detail.textRetention;
      };
      expect(await readDetail()).toMatchObject({
        status: "missing",
        reason: "not_checked",
      });
      await db.insert(caseLawTextRetentionVerdicts).values({
        decisionId: id,
        sourceId,
        payloadFingerprint: fingerprint,
        compositionFingerprint: "b".repeat(64),
        parserVersion: 7,
        oracleVersion: ORACLE_VERSION,
        exclusionVersion: EXCLUSION_VERSION,
        status: "assessed",
        retainedRatio: 1,
        components: [],
      });
      const checked = await readDetail();
      expect(checked).toMatchObject({
        status: "assessed",
        retainedRatio: 1,
        parserVersion: 7,
      });
      expect(Object.keys(checked)).not.toContain("payloadFingerprint");
      expect(Object.keys(checked)).not.toContain("rawS3Key");
      await db
        .update(caseLawDecisions)
        .set({ parserVersion: 8 })
        .where(eq(caseLawDecisions.id, id));
      expect(await readDetail()).toMatchObject({
        status: "unavailable",
        reason: "stale_verdict",
        retainedRatio: null,
      });
    });

    test("a decision nobody has fetched is pending", async () => {
      expect(await readState(await insertDecision(null))).toEqual({
        pending: true,
        unavailable: false,
      });
    });

    test("a decision the source had nothing for is terminal", async () => {
      // The empty string is the pipeline's "tried and got nothing"
      // marker. Reporting it as pending would send every later view back
      // through the fetch path for a document that does not exist.
      expect(await readState(await insertDecision(""))).toEqual({
        pending: false,
        unavailable: true,
      });
    });

    test("a decision with its document is neither", async () => {
      expect(
        await readState(await insertDecision("Decision\n\nReasons.")),
      ).toEqual({ pending: false, unavailable: false });
    });
  });
}
