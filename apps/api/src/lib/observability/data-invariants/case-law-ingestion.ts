import { and, eq, inArray, sql } from "drizzle-orm";

import { DAY_IN_MS } from "@stll/time";

import { caseLawSources } from "@/api/db/schema";
import { sourceArrivalsCountSql } from "@/api/lib/case-law/source-arrivals-refresh";
import type { CaseLawDailyBand } from "@/api/lib/observability/data-invariants/config-schema";
import {
  DATA_INVARIANT_ID,
  type DataInvariant,
  type DataInvariantFinding,
  type DataInvariantReadDb,
  judgeDataInvariant,
} from "@/api/lib/observability/data-invariants/invariant";

type IngestionReason = "no-enabled-source" | "below-band" | "above-band";

type CaseLawIngestionDailyBandOptions = {
  db: DataInvariantReadDb;
  bands: readonly CaseLawDailyBand[];
};

/**
 * Published arrivals per enabled source over the 24 hours before the run,
 * through the weekly refresh's own count, so this reads one day of the same
 * `(source_id, created_at)` index range per source.
 */
const readDailyArrivals = async ({
  db,
  adapterKeys,
  now,
}: {
  db: DataInvariantReadDb;
  adapterKeys: readonly string[];
  now: Date;
}) =>
  await db(
    async (tx) =>
      await tx
        .select({
          adapterKey: caseLawSources.adapterKey,
          arrivals: sql<number>`(${sourceArrivalsCountSql({
            since: new Date(now.getTime() - DAY_IN_MS),
            sourceId: caseLawSources.id,
            until: now,
          })})`.mapWith(Number),
        })
        .from(caseLawSources)
        .where(
          and(
            eq(caseLawSources.enabled, true),
            inArray(caseLawSources.adapterKey, [...adapterKeys]),
          ),
        ),
  );

/**
 * Each banded adapter's enabled sources published between `min` and `max`
 * decisions over the last day. Below the band is a stalled or empty-handed
 * crawl that still reports success; above it is a re-ingest or a duplicate
 * flood. Adapters without a band are not judged: their normal volume is the
 * deployment's to state.
 */
export const caseLawIngestionDailyBandInvariant = ({
  db,
  bands,
}: CaseLawIngestionDailyBandOptions): DataInvariant<
  IngestionReason,
  typeof DATA_INVARIANT_ID.caseLawIngestionDailyBand
> => ({
  id: DATA_INVARIANT_ID.caseLawIngestionDailyBand,
  owner: "case-law-ingestion",
  severity: "warning",
  check: async ({ now }) => {
    if (bands.length === 0) {
      return { status: "skipped", reason: "not-configured" };
    }
    const rows = await readDailyArrivals({
      db,
      adapterKeys: bands.map(({ adapterKey }) => adapterKey),
      now,
    });
    const arrivalsByAdapter = new Map<string, number>();
    for (const { adapterKey, arrivals } of rows) {
      arrivalsByAdapter.set(
        adapterKey,
        (arrivalsByAdapter.get(adapterKey) ?? 0) + arrivals,
      );
    }
    const findings: DataInvariantFinding<IngestionReason>[] = [];
    for (const { adapterKey, min, max } of bands) {
      const expected = `${min}..${max} per day`;
      const arrivals = arrivalsByAdapter.get(adapterKey);
      if (arrivals === undefined) {
        findings.push({
          target: adapterKey,
          reason: "no-enabled-source",
          observed: null,
          expected,
        });
      } else if (arrivals < min) {
        findings.push({
          target: adapterKey,
          reason: "below-band",
          observed: arrivals,
          expected,
        });
      } else if (arrivals > max) {
        findings.push({
          target: adapterKey,
          reason: "above-band",
          observed: arrivals,
          expected,
        });
      }
    }
    return judgeDataInvariant(bands.length, findings);
  },
});
