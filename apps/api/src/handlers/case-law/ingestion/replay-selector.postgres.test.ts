import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawDecisions,
  caseLawReplayBlocked,
  caseLawSources,
} from "@/api/db/schema";
import { STORED_RAW_REPARSE_REJECTION } from "@/api/handlers/case-law/ingestion/adapter";
import {
  CASE_LAW_REPLAY_SCOPE,
  selectReplayPage,
  selectScopeEnd,
} from "@/api/handlers/case-law/ingestion/replay";
import { createSafeId } from "@/api/lib/branded-types";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !enabled) {
  describe.skip("background replay selector", () => {
    test("requires an explicitly enabled Postgres database", () => {
      expect(enabled && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("background replay selector", () => {
    const { db, cleanUp } = openGatedTestDatabase(databaseUrl);
    const scopedDb: ScopedDb = async (callback) =>
      await db.transaction(callback);
    const sourceId = createSafeId<"caseLawSource">();
    const otherSourceId = createSafeId<"caseLawSource">();
    cleanUp(async () => {
      await db
        .delete(caseLawReplayBlocked)
        .where(eq(caseLawReplayBlocked.sourceId, sourceId));
      await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
      await db
        .delete(caseLawSources)
        .where(eq(caseLawSources.id, otherSourceId));
    });

    test("pages only parser lag by ID and excludes all terminal receipts in their parser generation", async () => {
      await db.insert(caseLawSources).values([
        {
          id: sourceId,
          adapterKey: `selector-${sourceId}`,
          name: "selector fixture",
        },
        {
          id: otherSourceId,
          adapterKey: `selector-${otherSourceId}`,
          name: "other selector fixture",
        },
      ]);
      const cases = [
        { parserVersion: null, eligible: true },
        { parserVersion: 1, eligible: true },
        { parserVersion: 2, eligible: false },
        { parserVersion: 3, eligible: false },
        {
          parserVersion: 1,
          eligible: false,
          blockedVersion: 2,
          outcome: "rejected" as const,
        },
        {
          parserVersion: 1,
          eligible: false,
          blockedVersion: 2,
          outcome: "changed" as const,
        },
        {
          parserVersion: 1,
          eligible: false,
          blockedVersion: 2,
          outcome: "unchanged" as const,
        },
        { parserVersion: 1, eligible: true, blockedVersion: 1 },
        { parserVersion: 1, eligible: false, redacted: true },
        { parserVersion: 1, eligible: false, missingRaw: true },
        { parserVersion: 1, eligible: false, otherSource: true },
      ].map((fixture, index) =>
        Object.assign(fixture, {
          id: createSafeId<"caseLawDecision">(),
          index,
        }),
      );
      for (const fixture of cases) {
        await db.insert(caseLawDecisions).values({
          id: fixture.id,
          sourceId: fixture.otherSource ? otherSourceId : sourceId,
          caseNumber: `selector-${fixture.index}`,
          court: "fixture court",
          country: "CZE",
          language: "cs",
          parserVersion: fixture.parserVersion,
          sourceRawS3Key: fixture.missingRaw ? null : `fixture/${fixture.id}`,
          redactedAt: fixture.redacted
            ? new Date("2026-01-01T00:00:00Z")
            : null,
          // Reverse timestamps force the test to distinguish ID and operator order.
          createdAt: new Date(Date.UTC(2026, 0, cases.length - fixture.index)),
        });
        if (fixture.blockedVersion !== undefined) {
          await db.insert(caseLawReplayBlocked).values({
            sourceId,
            decisionId: fixture.id,
            parserVersionFrom: fixture.parserVersion,
            parserVersionTo: fixture.blockedVersion,
            outcome: fixture.outcome ?? "rejected",
            reason:
              fixture.outcome === "changed" || fixture.outcome === "unchanged"
                ? null
                : STORED_RAW_REPARSE_REJECTION.IDENTITY_MISMATCH,
          });
        }
      }
      const selection = {
        type: "background",
        currentParserVersion: 2,
        mode: "enrolled",
      } as const;
      const scope = CASE_LAW_REPLAY_SCOPE.SOURCE;
      const until = await selectScopeEnd({
        scopedDb,
        sourceId,
        scope,
        selection,
      });
      expect(until).not.toBeNull();
      if (until === null) {
        return;
      }
      const expected = cases
        .filter((fixture) => fixture.eligible)
        .map((fixture) => fixture.id)
        .toSorted();
      const seen: typeof expected = [];
      let after: (typeof expected)[number] | null = null;
      for (let step = 0; step <= cases.length; step += 1) {
        const page = await selectReplayPage({
          scopedDb,
          sourceId,
          scope,
          selection,
          after,
          until,
          limit: 1,
        });
        const row = page.at(0);
        if (row === undefined) {
          break;
        }
        seen.push(row.id);
        after = row.id;
        // A durable successful write drops the row from lag; its ID remains a valid cursor.
        await db
          .update(caseLawDecisions)
          .set({ parserVersion: 2 })
          .where(eq(caseLawDecisions.id, row.id));
      }
      expect(seen).toEqual(expected);
      expect(
        await selectScopeEnd({ scopedDb, sourceId, scope, selection }),
      ).toBeNull();
      const nextGeneration = await selectScopeEnd({
        scopedDb,
        sourceId,
        scope,
        selection: {
          type: "background",
          currentParserVersion: 3,
          mode: "enrolled",
        },
      });
      expect(nextGeneration).not.toBeNull();
      if (nextGeneration === null) {
        return;
      }
      const nextRows = await selectReplayPage({
        scopedDb,
        sourceId,
        scope,
        selection: {
          type: "background",
          currentParserVersion: 3,
          mode: "enrolled",
        },
        after: null,
        until: nextGeneration,
        limit: cases.length,
      });
      expect(nextRows.map((row) => row.id)).toEqual(
        cases
          .filter(
            (fixture) =>
              !fixture.redacted &&
              !fixture.missingRaw &&
              !fixture.otherSource &&
              fixture.parserVersion !== 3,
          )
          .map((fixture) => fixture.id)
          .toSorted(),
      );
    });
  });
}
