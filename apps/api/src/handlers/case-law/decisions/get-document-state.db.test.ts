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

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";

import { authRelationsPart } from "@/api/db/auth-schema";
import { caseLawDecisions, caseLawSources, relations } from "@/api/db/schema";
import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import { readDecisionHandler } from "@/api/handlers/case-law/decisions/get";
import type { SafeId } from "@/api/lib/branded-types";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";

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
    const db = drizzle(databaseUrl, {
      relations: { ...relations, ...authRelationsPart },
    });

    let sourceId: SafeId<"caseLawSource">;
    const created: SafeId<"caseLawDecision">[] = [];
    const suffix = Bun.randomUUIDv7().slice(0, 8);

    const insertDecision = async (fulltext: string | null) => {
      const [row] = await db
        .insert(caseLawDecisions)
        .values({
          sourceId,
          caseNumber: `state-${fulltext === null ? "null" : fulltext.length}-${suffix}`,
          court: "Okresný súd",
          country: "SVK",
          language: "sk",
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
      const decision = await readDecisionHandler(id, caseLawPublicReadDb);
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
        where: { adapterKey: { eq: ADAPTER_KEYS.SK_COURTS } },
        columns: { id: true },
      });
      if (existing) {
        sourceId = existing.id;
        return;
      }
      const [source] = await db
        .insert(caseLawSources)
        .values({
          adapterKey: ADAPTER_KEYS.SK_COURTS,
          name: "SK courts read-state test",
          enabled: false,
        })
        .returning({ id: caseLawSources.id });
      if (!source) {
        throw new Error("expected source row");
      }
      sourceId = source.id;
    });

    afterAll(async () => {
      if (created.length > 0) {
        await db
          .delete(caseLawDecisions)
          .where(inArray(caseLawDecisions.id, created));
      }
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
        await readState(await insertDecision("Rozsudok\n\nOdôvodnenie.")),
      ).toEqual({ pending: false, unavailable: false });
    });
  });
}
