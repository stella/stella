import { panic, Result } from "better-result";
import { sql } from "drizzle-orm";

import { softLawSources } from "@/api/db/schema";
import { runSoftLawIngestion } from "@/api/handlers/soft-law/ingestion";
import { createSafeId } from "@/api/lib/branded-types";
import { withAggregateSavepoint } from "@/api/lib/db/aggregate-lock";
import { rawSourcePayloadKey } from "@/api/lib/legal-search/raw-source-storage";
import type {
  SoftLawDocumentInput,
  SoftLawEntry,
  SoftLawSourceAdapter,
} from "@/api/lib/legal-search/soft-law-types";
import { createSchedulerTaskRegistry } from "@/api/lib/scheduler/registry";
import {
  createSoftLawSyncTask,
  SYNC_SOFT_LAW_TASK,
} from "@/api/lib/scheduler/tasks/soft-law-sync";
import type { SchedulerTaskContext } from "@/api/lib/scheduler/types";
import type { GatedTestClientScope } from "@/api/tests/gated-test-database";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import { measureCapturedRun } from "./hosted-erasure-run";
import { QUERY_PERF_CONNECTION_SETTINGS } from "./settings";

const BATCH_DOCUMENTS = 25;
const FIXTURE_AUTHORITY = "cz-uoou";
const DESCRIPTOR = {
  license: "public-domain",
  attribution: null,
  allowsRedistribution: false,
  allowsDerivedAi: false,
} as const;

const entryOf = (index: number): SoftLawEntry => ({
  type: "document",
  url: `https://publisher.example/guidance/${String(index)}`,
  metadata: {
    title: `Guidance ${String(index)}`,
    kind: "methodology",
    statedReference: { state: "stated", value: `REF-${String(index)}` },
    issuedOn: { state: "not_stated" },
    validity: { state: "not_stated", basis: "source_stated" },
  },
  sourceDates: {},
});

const documentOf = (entry: SoftLawEntry) =>
  ({
    metadata: entry.metadata,
    raw: [
      {
        role: "document",
        bytes: new TextEncoder().encode(entry.metadata.title),
        contentType: "text/html",
      },
    ],
    text: entry.metadata.title,
    extractionQuality: "html",
    sourceDates: entry.sourceDates,
  }) as const satisfies SoftLawDocumentInput;

const fixtureAdapter = (key: string) =>
  ({
    key,
    authority: FIXTURE_AUTHORITY,
    access: {
      publisherGate: "uoou-cz",
      userAgent: "Stella/1.0 (+https://stella.example/contact)",
      window: { type: "any_time" },
    },
    discover: async () =>
      await Promise.resolve(
        Result.ok({
          entries: Array.from({ length: BATCH_DOCUMENTS }, (_, index) =>
            entryOf(index),
          ),
          nextCursor: null,
        }),
      ),
    fetchDocument: async (entry) =>
      await Promise.resolve(Result.ok(documentOf(entry))),
    getTotalCount: async () =>
      await Promise.resolve({ type: "no-count-endpoint" as const }),
    sliceWalk: { type: "unsupported", reason: "Complete listing" },
    sourceFields: {
      status: "declared",
      fields: {},
      listSourceFields: () => [],
    },
    sourceSurfaces: { surfaces: {} },
  }) as const satisfies SoftLawSourceAdapter;

const noopTask = () => undefined;

/**
 * One fixed ingestion batch for one source while another source's history
 * grows beside it: a statement that scans the shared tables shows up as growth.
 */
export const measureSoftLawSyncHistory = async (
  openClient: GatedTestClientScope["openClient"],
) => {
  const { db } = openClient({ connection: QUERY_PERF_CONNECTION_SETTINGS });
  const measurements = [];
  for (const history of [1000, 10_000]) {
    const historySource = createSafeId<"softLawSource">();
    const sourceId = createSafeId<"softLawSource">();
    const key = `soft-law-sync-perf-${sourceId}`;
    // db-await-in-loop: isolated scenarios run sequentially, each seeding its own history.
    await db.insert(softLawSources).values([
      {
        id: historySource,
        adapterKey: `soft-law-sync-history-${historySource}`,
        descriptor: DESCRIPTOR,
      },
      { id: sourceId, adapterKey: key, descriptor: DESCRIPTOR },
    ]);
    // db-await-in-loop: the history lands before the fixed batch is captured.
    await db.execute(sql`INSERT INTO soft_law_documents (
        id, source_id, identity_key, jurisdiction, authority, kind, title,
        stated_reference_state, issued_on_state, listing_state, validity_state,
        validity_basis, first_seen_at, last_seen_at, last_seen_run
      )
      SELECT gen_random_uuid(), ${historySource}::uuid, 'history-' || n, 'CZE',
        ${FIXTURE_AUTHORITY}, 'methodology', 'History ' || n, 'not_stated',
        'not_stated', 'listed', 'not_stated', 'source_stated', now(), now(),
        gen_random_uuid()
      FROM generate_series(1, ${history}) n`);
    // db-await-in-loop: current statistics before the task is captured.
    await db.execute(sql`ANALYZE soft_law_documents`);
    const adapter = fixtureAdapter(key);
    // db-await-in-loop: one measured run per independently seeded history size.
    const measured = await measureCapturedRun({
      openClient,
      label: "soft-law sync",
      execute: async (tx) => {
        const task =
          createSchedulerTaskRegistry({
            reapOwnerlessChatTurns: noopTask,
            refreshCaseLawCoverage: noopTask,
            syncSoftLaw: createSoftLawSyncTask({
              authorities: () => [FIXTURE_AUTHORITY],
              sync: async ({ signal }) =>
                await runSoftLawIngestion({
                  sourceId,
                  adapter,
                  scopedDb: async (work) =>
                    await withAggregateSavepoint(tx, work),
                  signal,
                  writeRaw: (options) =>
                    Promise.resolve(rawSourcePayloadKey(options)),
                }),
            }),
          }).get(SYNC_SOFT_LAW_TASK) ?? panic("Soft-law sync is unregistered");
        await task(
          asTestRaw<SchedulerTaskContext>({
            logger: { info: noopTask },
            signal: new AbortController().signal,
          }),
        );
      },
    });
    measurements.push({ history, ...measured });
    // db-await-in-loop: each scenario removes its own rows before the next seeds.
    await db.execute(
      sql`DELETE FROM soft_law_documents WHERE source_id = ${historySource}::uuid`,
    );
    // db-await-in-loop: paired with the row cleanup above.
    await db.execute(
      sql`DELETE FROM soft_law_sources WHERE id IN (${historySource}::uuid, ${sourceId}::uuid)`,
    );
  }
  return measurements;
};
