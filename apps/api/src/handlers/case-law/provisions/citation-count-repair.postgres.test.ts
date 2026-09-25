import type { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sql";

import {
  caseLawDecisions,
  caseLawSources,
  caseLawProvisionCitations,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgresTests) {
  describe.skip("statute citation projection concurrency (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  for (const transition of ["publish", "unpublish", "repair"] as const) {
    for (const firstOperation of ["writer", "transition"] as const) {
      test(`${firstOperation} serializes with ${transition} and leaves exact citation counts`, async () => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const firstClient = openClient().sql;
          const secondClient = openClient().sql;
          const { sql: observer, db } = openClient();
          const source = caseLawSourceRow({
            adapterKey: `citation-concurrency-${Bun.randomUUIDv7()}`,
          });
          const decisionId = createSafeId<"caseLawDecision">();
          const firstFinished = Promise.withResolvers<undefined>();
          const releaseFirst = Promise.withResolvers<undefined>();
          const secondStarted = Promise.withResolvers<number>();
          const listingOnly = {
            _stellaPartialObservation: { isListingOnly: true },
          };
          const writeCitation = async (client: SQL) => {
            await drizzle({ client }).insert(caseLawProvisionCitations).values({
              id: createSafeId<"caseLawProvisionCitation">(),
              decisionId,
              jurisdiction: "CZE",
              workIdentifier: "89/2012 Sb.",
              workNumber: 89,
              workYear: 2012,
              workCollection: "Sb.",
              unit: "section",
              section: 1,
              workEli: "/eli/cz/sb/2012/89",
              anchor: "s1",
              spanStart: 0,
              spanEnd: 5,
              sentenceText: "Citation",
              confidence: 1,
            });
          };
          const applyTransition = async (client: SQL) => {
            switch (transition) {
              case "publish":
                await client`UPDATE case_law_decisions SET metadata = '{}'::jsonb WHERE id = ${decisionId}::uuid`;
                return;
              case "unpublish":
                await client`UPDATE case_law_decisions SET metadata = '{"_stellaPartialObservation":{"isListingOnly":true}}'::jsonb WHERE id = ${decisionId}::uuid`;
                return;
              case "repair":
                await client`SELECT refresh_case_law_statute_citation_memberships(${decisionId}::uuid)`;
                return;
            }
          };
          let operations: Promise<unknown>[] = [];
          try {
            await db.insert(caseLawSources).values(source);
            await db.insert(caseLawDecisions).values({
              id: decisionId,
              sourceId: source.id,
              country: "CZE",
              court: "Court",
              language: "cs",
              caseNumber: decisionId,
              metadata: transition === "publish" ? listingOnly : {},
            });
            const first = firstClient.begin(async (client) => {
              await client`SET LOCAL statement_timeout = '5s'`;
              await (firstOperation === "writer"
                ? writeCitation(client)
                : applyTransition(client));
              firstFinished.resolve(undefined);
              await releaseFirst.promise;
            });
            operations = [first];
            await Promise.race([firstFinished.promise, first]);
            const second = secondClient.begin(async (client) => {
              await client`SET LOCAL statement_timeout = '5s'`;
              const rows = await client`SELECT pg_backend_pid() AS pid`;
              const pid: unknown = rows.at(0)?.pid;
              if (typeof pid !== "number") {
                return secondStarted.reject(
                  new TypeError("Expected PostgreSQL backend PID"),
                );
              }
              secondStarted.resolve(pid);
              await (firstOperation === "writer"
                ? applyTransition(client)
                : writeCitation(client));
            });
            operations.push(second);
            const secondPid = await secondStarted.promise;
            // Observe a real PostgreSQL lock wait, so scheduler timing cannot make this vacuous.
            const deadline = Date.now() + 3000;
            let blocked = false;
            while (!blocked && Date.now() < deadline) {
              const rows = await observer`SELECT EXISTS (
              SELECT 1 FROM pg_stat_activity WHERE pid = ${secondPid}
                AND cardinality(pg_blocking_pids(pid)) > 0
            ) AS blocked`;
              blocked = rows.at(0)?.blocked === true;
              if (!blocked) {
                await Bun.sleep(10);
              }
            }
            expect(blocked).toBe(true);
            releaseFirst.resolve(undefined);
            await Promise.all(operations);
            const counts = await observer`SELECT target_type, decision_count
            FROM case_law_statute_citation_counts WHERE source_id = ${source.id}::uuid
            ORDER BY target_type`;
            expect([...counts]).toEqual(
              transition === "unpublish"
                ? []
                : [
                    { target_type: "provision", decision_count: 1 },
                    { target_type: "work", decision_count: 1 },
                  ],
            );
          } finally {
            releaseFirst.resolve(undefined);
            await Promise.allSettled(operations);
            await observer`DELETE FROM case_law_decisions WHERE id = ${decisionId}::uuid`;
            await observer`DELETE FROM case_law_sources WHERE id = ${source.id}::uuid`;
          }
        });
      }, 15_000);
    }
  }
}
