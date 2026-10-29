import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";
import * as v from "valibot";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { executeRowsScopedDb } from "@/api/tests/helpers/pglite-rows-scoped-db";
import { createTestPglite } from "@/api/tests/pglite-test-db";

import { caseLawIngestionDailyBandInvariant } from "./case-law-ingestion";
import {
  type CaseLawDailyBand,
  caseLawDailyBandsEnvSchema,
} from "./config-schema";
import { DATA_INVARIANT_ID } from "./invariant";

const TIMEOUT = 120_000;
const NOW = new Date("2026-10-17T09:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;

const steadySourceId = createSafeId<"caseLawSource">();
const stalledSourceId = createSafeId<"caseLawSource">();
const floodedSourceId = createSafeId<"caseLawSource">();
const disabledSourceId = createSafeId<"caseLawSource">();

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const readDb = () =>
  executeRowsScopedDb(
    async (run) => await db.transaction(async (tx) => await run(tx)),
  );

type ArrivalsOptions = {
  sourceId: SafeId<"caseLawSource">;
  count: number;
  hoursAgo: number;
};

const arrivals = ({ sourceId, count, hoursAgo }: ArrivalsOptions) =>
  Array.from({ length: count }, (_, index) => ({
    caseNumber: `${sourceId} ${hoursAgo}h ${index}`,
    country: "CZE",
    court: "Nejvyšší soud",
    language: "cs",
    sourceId,
    createdAt: new Date(NOW.getTime() - hoursAgo * HOUR_MS),
    updatedAt: new Date(NOW.getTime() - hoursAgo * HOUR_MS),
    metadata: {},
  }));

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  await db.insert(caseLawSources).values([
    caseLawSourceRow({ id: steadySourceId, adapterKey: ADAPTER_KEYS.CZ_NS }),
    caseLawSourceRow({ id: stalledSourceId, adapterKey: ADAPTER_KEYS.CZ_NSS }),
    caseLawSourceRow({ id: floodedSourceId, adapterKey: ADAPTER_KEYS.CZ_US }),
    caseLawSourceRow({
      id: disabledSourceId,
      adapterKey: ADAPTER_KEYS.SK_COURTS,
      enabled: false,
    }),
  ]);
  await db.insert(caseLawDecisions).values([
    ...arrivals({ sourceId: steadySourceId, count: 3, hoursAgo: 2 }),
    // Outside the day: it must not count towards today's band.
    ...arrivals({ sourceId: stalledSourceId, count: 5, hoursAgo: 30 }),
    ...arrivals({ sourceId: floodedSourceId, count: 6, hoursAgo: 1 }),
    ...arrivals({ sourceId: disabledSourceId, count: 2, hoursAgo: 1 }),
  ]);
}, TIMEOUT);

afterAll(async () => {
  await client.close();
});

const check = async (bands: readonly CaseLawDailyBand[]) =>
  await caseLawIngestionDailyBandInvariant({ db: readDb(), bands }).check({
    now: NOW,
    signal: new AbortController().signal,
  });

describe("published arrivals per source against the daily band", () => {
  test(
    "a stalled, a flooded and a disabled source each fire; a steady one holds",
    async () => {
      const verdict = await check([
        { adapterKey: ADAPTER_KEYS.CZ_NS, min: 1, max: 10 },
        { adapterKey: ADAPTER_KEYS.CZ_NSS, min: 1, max: 10 },
        { adapterKey: ADAPTER_KEYS.CZ_US, min: 0, max: 5 },
        { adapterKey: ADAPTER_KEYS.SK_COURTS, min: 0, max: 10 },
      ]);

      expect(verdict).toEqual({
        status: "violated",
        checked: 4,
        findings: [
          {
            target: ADAPTER_KEYS.CZ_NSS,
            reason: "below-band",
            observed: 0,
            expected: "1..10 per day",
          },
          {
            target: ADAPTER_KEYS.CZ_US,
            reason: "above-band",
            observed: 6,
            expected: "0..5 per day",
          },
          {
            target: ADAPTER_KEYS.SK_COURTS,
            reason: "no-enabled-source",
            observed: null,
            expected: "0..10 per day",
          },
        ],
      });
    },
    TIMEOUT,
  );

  test(
    "band edges are inclusive",
    async () => {
      expect(
        await check([
          { adapterKey: ADAPTER_KEYS.CZ_NS, min: 3, max: 3 },
          { adapterKey: ADAPTER_KEYS.CZ_US, min: 6, max: 6 },
        ]),
      ).toEqual({ status: "held", checked: 2 });
    },
    TIMEOUT,
  );

  test("no configured band skips the invariant rather than holding it", async () => {
    const invariant = caseLawIngestionDailyBandInvariant({
      db: readDb(),
      bands: [],
    });
    expect(invariant.id).toBe(DATA_INVARIANT_ID.caseLawIngestionDailyBand);
    expect(
      await invariant.check({ now: NOW, signal: new AbortController().signal }),
    ).toEqual({ status: "skipped", reason: "not-configured" });
  });
});

describe("the band configuration", () => {
  const parse = (value: unknown) =>
    v.safeParse(caseLawDailyBandsEnvSchema, JSON.stringify(value));

  test("parses an adapter's band", () => {
    expect(
      v.parse(
        caseLawDailyBandsEnvSchema,
        JSON.stringify([{ adapterKey: ADAPTER_KEYS.CZ_NS, min: 1, max: 9 }]),
      ),
    ).toEqual([{ adapterKey: ADAPTER_KEYS.CZ_NS, min: 1, max: 9 }]);
    expect(v.parse(caseLawDailyBandsEnvSchema, undefined)).toEqual([]);
  });

  test.each([
    ["an inverted band", [{ adapterKey: ADAPTER_KEYS.CZ_NS, min: 5, max: 1 }]],
    ["an unknown adapter", [{ adapterKey: "nowhere", min: 0, max: 1 }]],
    [
      "a fractional bound",
      [{ adapterKey: ADAPTER_KEYS.CZ_NS, min: 0.5, max: 1 }],
    ],
    [
      "the same adapter twice",
      [
        { adapterKey: ADAPTER_KEYS.CZ_NS, min: 0, max: 1 },
        { adapterKey: ADAPTER_KEYS.CZ_NS, min: 0, max: 2 },
      ],
    ],
  ])("refuses %s", (_, value) => {
    expect(parse(value).success).toBe(false);
  });

  test("refuses text that is not JSON", () => {
    expect(v.safeParse(caseLawDailyBandsEnvSchema, "cz-ns=1..9").success).toBe(
      false,
    );
  });
});
