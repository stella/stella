import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { createHash } from "node:crypto";
import { MessageChannel, Worker } from "node:worker_threads";

import { buildScreeningIndex, SANCTIONS_SOURCES } from "@stll/sanctions";
import type { SanctionsEntry, SanctionsSource } from "@stll/sanctions";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  sanctionsEditionEntries,
  sanctionsEditions,
  sanctionsEntryPayloads,
  sanctionsSources,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { readSanctionsFreshness } from "@/api/lib/lists/sanctions/freshness";
import {
  createSanctionsIndexCache,
  SANCTIONS_INDEX_FAILURE_MEMO_MS,
} from "@/api/lib/lists/sanctions/screening-index";
import type { SanctionsActiveEdition } from "@/api/lib/lists/sanctions/screening-index";
import {
  SANCTIONS_MATCH_LIMIT,
  screenSanctionsSubject,
} from "@/api/lib/lists/sanctions/screening-service";
import type { SanctionsListOutcome } from "@/api/lib/lists/sanctions/screening-service";
import {
  SANCTIONS_SOURCE_CONFIG,
  sanctionsSourceIds,
} from "@/api/lib/lists/sanctions/source-config";
import { resetFailureObservationsForTesting } from "@/api/lib/observability/failure-shadow";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

import { createSanctionsMatcherPool } from "./matcher-pool";
import { createPublicSanctionsScreening } from "./public-screening";
import { loadEditionEntries } from "./screening-index";
import { createMatcherTestClock } from "./test-fixtures/matcher-test-clock";

const DB_TEST_TIMEOUT_MS = 120_000;
const HOUR_MS = 60 * 60 * 1000;
const VERIFIED_AT = new Date("2026-09-20T08:00:00Z");
const FRESH_NOW = new Date(VERIFIED_AT.getTime() + HOUR_MS);
// Past the 48-hour limit most lists carry, within the 14 days of the Czech one.
const STALE_NOW = new Date(VERIFIED_AT.getTime() + 72 * HOUR_MS);
const TRUNCATED_ENTRIES = SANCTIONS_MATCH_LIMIT + 5;

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let requestDb: ScopedDb;
const editionIds = new Map<SanctionsSource, string>();

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const entry = (
  source: SanctionsSource,
  sourceId: string,
  overrides: Partial<SanctionsEntry>,
): SanctionsEntry => ({
  source,
  issuer: SANCTIONS_SOURCES[source].issuer,
  sourceId,
  referenceNumber: null,
  entityType: "person",
  names: [{ name: `Unrelated Listed ${sourceId}`, quality: "strong" }],
  birthDates: [],
  nationalities: [],
  identifiers: [],
  addresses: [],
  programme: null,
  legalBasis: null,
  listedOn: null,
  sourceUrl: `https://lists.example/${source}/${sourceId}`,
  ...overrides,
});

const entriesFor = (source: SanctionsSource): SanctionsEntry[] => {
  const base = [entry(source, "1", {})];
  if (source === "eu") {
    return [
      ...base,
      entry(source, "2", {
        names: [{ name: "Ivan Petrovich Sidorov", quality: "strong" }],
        birthDates: [
          { precision: "day", year: 1960, month: 5, day: 12, circa: false },
        ],
        nationalities: [{ code: "RU", name: "Russia" }],
      }),
    ];
  }
  if (source === "un") {
    return [
      ...base,
      ...Array.from({ length: TRUNCATED_ENTRIES }, (_, index) =>
        entry(source, `acme-${String(index).padStart(2, "0")}`, {
          entityType: "organisation",
          names: [{ name: "Acme Trading Company", quality: "strong" }],
        }),
      ),
    ];
  }
  return base;
};

const seedSource = async (source: SanctionsSource) => {
  const entries = entriesFor(source);
  const editionId = Bun.randomUUIDv7();
  await db.insert(sanctionsSources).values({
    id: source,
    issuer: SANCTIONS_SOURCE_CONFIG[source].issuer,
    markerUrl: SANCTIONS_SOURCE_CONFIG[source].markerUrl,
  });
  await db.insert(sanctionsEditions).values({
    id: toSafeId<"sanctionsEdition">(editionId),
    sourceId: source,
    markerKey: sha256(`${source}:marker`),
    publishedAt: "2026-09-19",
    fileId: null,
    contentHash: sha256(`${source}:content`),
    entryCount: entries.length,
    state: "ready",
    activatedAt: VERIFIED_AT,
  });
  const payloads = entries.map((item) => ({
    contentHash: sha256(JSON.stringify(item)),
    payload: item,
  }));
  await db.insert(sanctionsEntryPayloads).values(payloads);
  await db.insert(sanctionsEditionEntries).values(
    entries.map((item, index) => ({
      editionId: toSafeId<"sanctionsEdition">(editionId),
      sourceEntryId: item.sourceId,
      contentHash: payloads[index]?.contentHash ?? "",
    })),
  );
  await db
    .update(sanctionsSources)
    .set({
      activeEditionId: toSafeId<"sanctionsEdition">(editionId),
      lastCheckedAt: VERIFIED_AT,
      lastSuccessfulVerifiedAt: VERIFIED_AT,
    })
    .where(eq(sanctionsSources.id, source));
  editionIds.set(source, editionId);
};

const HELD_AT = new Date(VERIFIED_AT.getTime() + HOUR_MS / 2);

/** A second edition of a list, fetched and held for review beside the active one. */
const seedHeldEdition = async (
  source: SanctionsSource,
): Promise<SanctionsActiveEdition> => {
  const entries = entriesFor(source);
  const id = toSafeId<"sanctionsEdition">(Bun.randomUUIDv7());
  await db.insert(sanctionsEditions).values({
    id,
    sourceId: source,
    markerKey: sha256(`${source}:held-marker`),
    publishedAt: "2026-09-20",
    fileId: null,
    contentHash: sha256(`${source}:held-content`),
    entryCount: entries.length,
    state: "staging",
  });
  await db.insert(sanctionsEditionEntries).values(
    entries.map((item) => ({
      editionId: id,
      sourceEntryId: item.sourceId,
      contentHash: sha256(JSON.stringify(item)),
    })),
  );
  await db
    .update(sanctionsSources)
    .set({
      heldEditionId: id,
      heldGuardCode: "contracted",
      heldAt: HELD_AT,
      heldPreviousCount: entries.length,
      heldNextCount: entries.length,
    })
    .where(eq(sanctionsSources.id, source));
  return {
    id,
    publishedAt: "2026-09-20",
    fileId: null,
    entryCount: entries.length,
  };
};

const clearHeldEdition = async (source: SanctionsSource) => {
  const [row] = await db
    .select({ heldEditionId: sanctionsSources.heldEditionId })
    .from(sanctionsSources)
    .where(eq(sanctionsSources.id, source));
  await db
    .update(sanctionsSources)
    .set({
      heldEditionId: null,
      heldGuardCode: null,
      heldAt: null,
      heldPreviousCount: null,
      heldNextCount: null,
    })
    .where(eq(sanctionsSources.id, source));
  const heldEditionId = row?.heldEditionId ?? null;
  if (heldEditionId !== null) {
    await db
      .delete(sanctionsEditionEntries)
      .where(eq(sanctionsEditionEntries.editionId, heldEditionId));
    await db
      .delete(sanctionsEditions)
      .where(eq(sanctionsEditions.id, heldEditionId));
  }
};

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  // The API request role: it reads the global lists and writes nothing.
  requestDb = async (fn) =>
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE stella`);
      return await fn(asTestRaw<Transaction>(tx));
    });
  for (const source of sanctionsSourceIds()) {
    await seedSource(source);
  }
}, DB_TEST_TIMEOUT_MS);

afterAll(async () => {
  await client.close();
});

const listOf = (
  lists: readonly SanctionsListOutcome[],
  source: SanctionsSource,
): SanctionsListOutcome => {
  const found = lists.find((list) => list.source === source);
  if (found === undefined) {
    throw new Error(`No outcome for ${source}`);
  }
  return found;
};

describe("sanctions screening service", () => {
  test(
    "answers clear only when every list answered, each naming its edition",
    async () => {
      const result = await screenSanctionsSubject({
        db: requestDb,
        subject: {
          type: "organization",
          name: "Blue Meadow Bakery",
          identifiers: [],
        },
        practiceJurisdictions: [],
        now: FRESH_NOW,
        indexCache: createSanctionsIndexCache(),
      });
      const screening = result.unwrap();
      expect(screening.status).toBe("clear");
      expect(screening.lists.map((list) => list.source).toSorted()).toEqual(
        sanctionsSourceIds().toSorted(),
      );
      for (const list of screening.lists) {
        expect(list).toMatchObject({
          status: "clear",
          editionId: editionIds.get(list.source),
          publishedAt: "2026-09-19",
          verifiedAt: VERIFIED_AT.toISOString(),
          classification: "informational",
          issuer: SANCTIONS_SOURCES[list.source].issuer,
        });
      }
    },
    DB_TEST_TIMEOUT_MS,
  );

  test(
    "returns control to the event loop between warm list screenings",
    async () => {
      let turns = 0;
      const observedTurns: number[] = [];
      const result = await screenSanctionsSubject({
        db: requestDb,
        subject: {
          type: "organization",
          name: "Blue Meadow Bakery",
          identifiers: [],
        },
        practiceJurisdictions: [],
        now: FRESH_NOW,
        indexCache: {
          get: async ({ source, edition }) => {
            observedTurns.push(turns);
            setImmediate(() => {
              turns += 1;
            });
            return Result.ok(
              buildScreeningIndex([
                {
                  entries: entriesFor(source),
                  version: {
                    source,
                    publishedAt: edition.publishedAt,
                    fileId: edition.fileId,
                  },
                },
              ]),
            );
          },
          refresh: async () => undefined,
        },
      });
      expect(result.unwrap().status).toBe("clear");
      expect(observedTurns).toHaveLength(sanctionsSourceIds().length);
      expect(observedTurns).toEqual(observedTurns.map((_, index) => index));
    },
    DB_TEST_TIMEOUT_MS,
  );

  test(
    "reports a strong name with a conflicting birth date as a possible match",
    async () => {
      const result = await screenSanctionsSubject({
        db: requestDb,
        subject: {
          type: "person",
          name: "Ivan Petrovich Sidorov",
          birthDate: { year: 1971 },
          nationalityCodes: ["RU"],
        },
        practiceJurisdictions: ["CZ"],
        now: FRESH_NOW,
        indexCache: createSanctionsIndexCache(),
      });
      const screening = result.unwrap();
      expect(screening.status).toBe("possible-match");
      const eu = listOf(screening.lists, "eu");
      expect(eu.status).toBe("possible-match");
      expect(eu.classification).toBe("binding");
      expect(eu.totalMatches).toBe(1);
      expect(eu.possibleMatches).toEqual([
        expect.objectContaining({
          sourceEntryId: "2",
          editionId: editionIds.get("eu"),
          sourceUrl: "https://lists.example/eu/2",
          name: "Ivan Petrovich Sidorov",
          evidence: expect.objectContaining({
            birthDate: "mismatch",
            nationality: "match",
            conflicts: ["birth-date"],
          }),
        }),
      ]);
      expect(eu.possibleMatches.at(0)?.score).toBeGreaterThanOrEqual(
        screening.cutoff,
      );
      expect(listOf(screening.lists, "uk")).toMatchObject({
        status: "clear",
        classification: "informational",
      });
      expect(listOf(screening.lists, "cz").classification).toBe("binding");
    },
    DB_TEST_TIMEOUT_MS,
  );

  test(
    "bounds the returned matches and says how many there were",
    async () => {
      const result = await screenSanctionsSubject({
        db: requestDb,
        subject: {
          type: "organization",
          name: "Acme Trading Company",
          identifiers: [],
        },
        practiceJurisdictions: [],
        now: FRESH_NOW,
        indexCache: createSanctionsIndexCache(),
      });
      const un = listOf(result.unwrap().lists, "un");
      expect(un).toMatchObject({
        status: "possible-match",
        totalMatches: TRUNCATED_ENTRIES,
        truncated: true,
      });
      expect(un.possibleMatches).toHaveLength(SANCTIONS_MATCH_LIMIT);
    },
    DB_TEST_TIMEOUT_MS,
  );

  test(
    "makes a stale list unavailable, hides its matches and never aggregates to clear",
    async () => {
      const result = await screenSanctionsSubject({
        db: requestDb,
        subject: {
          type: "person",
          name: "Ivan Petrovich Sidorov",
          birthDate: null,
          nationalityCodes: [],
        },
        practiceJurisdictions: [],
        now: STALE_NOW,
        indexCache: createSanctionsIndexCache(),
      });
      const screening = result.unwrap();
      expect(screening.status).toBe("unavailable");
      expect(listOf(screening.lists, "eu")).toMatchObject({
        status: "unavailable",
        reason: "stale",
        editionId: editionIds.get("eu"),
        verifiedAt: VERIFIED_AT.toISOString(),
        totalMatches: 0,
        possibleMatches: [],
      });
      // The Czech list is verified within its own 14-day limit.
      expect(listOf(screening.lists, "cz")).toMatchObject({
        status: "clear",
        editionId: editionIds.get("cz"),
      });
    },
    DB_TEST_TIMEOUT_MS,
  );

  test(
    "makes a list whose edition cannot be read unavailable, and the rest still answer",
    async () => {
      const result = await screenSanctionsSubject({
        db: requestDb,
        subject: {
          type: "organization",
          name: "Blue Meadow Bakery",
          identifiers: [],
        },
        practiceJurisdictions: [],
        now: FRESH_NOW,
        indexCache: {
          get: async ({ source, ...props }) =>
            source === "uk"
              ? Result.err({ code: "load-failed" })
              : await createSanctionsIndexCache().get({ source, ...props }),
          refresh: async () => {},
        },
      });
      const screening = result.unwrap();
      expect(screening.status).toBe("unavailable");
      expect(listOf(screening.lists, "uk")).toMatchObject({
        status: "unavailable",
        reason: "load-failed",
      });
      expect(listOf(screening.lists, "eu").status).toBe("clear");
    },
    DB_TEST_TIMEOUT_MS,
  );

  test(
    "builds each edition's index once and reuses it",
    async () => {
      let reads = 0;
      const countingDb: ScopedDb = async (fn) => {
        reads += 1;
        return await requestDb(fn);
      };
      const indexCache = createSanctionsIndexCache();
      const run = async () =>
        await screenSanctionsSubject({
          db: countingDb,
          subject: {
            type: "organization",
            name: "Blue Meadow Bakery",
            identifiers: [],
          },
          practiceJurisdictions: [],
          now: FRESH_NOW,
          indexCache,
        });
      await run();
      const firstReads = reads;
      await run();
      // The second screening reads freshness only.
      expect(reads - firstReads).toBe(1);
      expect(firstReads).toBeGreaterThan(sanctionsSourceIds().length);
    },
    DB_TEST_TIMEOUT_MS,
  );

  test(
    "keeps the other lists answering when one list's index cannot be built, and retries it after a pause",
    async () => {
      let clock = FRESH_NOW.getTime();
      let failing = true;
      const builds = new Map<SanctionsSource, number>();
      const reported: { source: SanctionsSource; editionId: string }[] = [];
      const indexCache = createSanctionsIndexCache({
        nowMs: () => clock,
        build: (lists) => {
          const source = lists.at(0)?.version.source;
          if (source !== undefined) {
            builds.set(source, (builds.get(source) ?? 0) + 1);
          }
          if (failing && source === "ch") {
            throw new Error("index build failed");
          }
          return buildScreeningIndex(lists);
        },
        reportFailure: (failure, ids) => {
          expect(failure.stage).toBe("build-failed");
          reported.push(ids);
        },
      });
      const run = async () =>
        (
          await screenSanctionsSubject({
            db: requestDb,
            subject: {
              type: "organization",
              name: "Blue Meadow Bakery",
              identifiers: [],
            },
            practiceJurisdictions: ["CH"],
            now: FRESH_NOW,
            indexCache,
          })
        ).unwrap();

      const first = await run();
      expect(first.status).toBe("unavailable");
      expect(listOf(first.lists, "ch")).toMatchObject({
        status: "unavailable",
        reason: "load-failed",
        classification: "binding",
        editionId: editionIds.get("ch"),
      });
      for (const list of first.lists.filter(({ source }) => source !== "ch")) {
        expect(list.status).toBe("clear");
      }
      // Telemetry names the list and edition, nothing about the subject.
      expect(reported).toEqual([
        { source: "ch", editionId: editionIds.get("ch") ?? "" },
      ]);

      // Inside the pause the failed edition is not read or built again.
      const second = await run();
      expect(listOf(second.lists, "ch").reason).toBe("load-failed");
      expect(builds.get("ch")).toBe(1);
      expect(reported).toHaveLength(1);

      // After it, the next screening tries again.
      failing = false;
      clock += SANCTIONS_INDEX_FAILURE_MEMO_MS;
      const third = await run();
      expect(third.status).toBe("clear");
      expect(listOf(third.lists, "ch").status).toBe("clear");
      expect(builds.get("ch")).toBe(2);
      // The lists that built the first time were never built again.
      expect(builds.get("eu")).toBe(1);
    },
    DB_TEST_TIMEOUT_MS,
  );

  test(
    "makes a list unavailable when its index read rejects outright, and the rest still answer",
    async () => {
      const healthy = createSanctionsIndexCache();
      const result = await screenSanctionsSubject({
        db: requestDb,
        subject: {
          type: "organization",
          name: "Blue Meadow Bakery",
          identifiers: [],
        },
        practiceJurisdictions: [],
        now: FRESH_NOW,
        indexCache: {
          get: async (props) =>
            props.source === "eu"
              ? await Promise.reject(new Error("connection reset"))
              : await healthy.get(props),
          refresh: async () => {},
        },
      });
      const screening = result.unwrap();
      expect(listOf(screening.lists, "eu")).toMatchObject({
        status: "unavailable",
        reason: "load-failed",
      });
      expect(listOf(screening.lists, "un").status).toBe("clear");
    },
    DB_TEST_TIMEOUT_MS,
  );

  test(
    "reports an update held for review on its list, which still screens the edition it had",
    async () => {
      const held = await seedHeldEdition("ch");
      try {
        const result = await screenSanctionsSubject({
          db: requestDb,
          subject: {
            type: "organization",
            name: "Blue Meadow Bakery",
            identifiers: [],
          },
          practiceJurisdictions: [],
          now: FRESH_NOW,
          indexCache: createSanctionsIndexCache(),
        });
        const screening = result.unwrap();
        expect(listOf(screening.lists, "ch")).toMatchObject({
          status: "clear",
          editionId: editionIds.get("ch"),
          pendingUpdate: {
            code: "contracted",
            heldAt: HELD_AT.toISOString(),
            previousCount: entriesFor("ch").length,
            nextCount: held.entryCount,
          },
        });
        expect(listOf(screening.lists, "eu").pendingUpdate).toBeNull();
      } finally {
        await clearHeldEdition("ch");
      }
    },
    DB_TEST_TIMEOUT_MS,
  );

  test(
    "builds a newly activated edition ahead of the next check only for a list already in use",
    async () => {
      const held = await seedHeldEdition("uk");
      try {
        let builds = 0;
        const indexCache = createSanctionsIndexCache({
          build: (lists) => {
            builds += 1;
            return buildScreeningIndex(lists);
          },
        });
        const freshness = await readSanctionsFreshness({
          db: requestDb,
          now: FRESH_NOW,
        });
        const active = (source: SanctionsSource) => {
          const edition = freshness.find(
            (sourceFreshness) => sourceFreshness.source === source,
          )?.edition;
          if (edition === null || edition === undefined) {
            throw new Error(`No active ${source} edition`);
          }
          return edition;
        };

        // A list this process never screened stays cold.
        await indexCache.refresh({
          db: requestDb,
          source: "uk",
          edition: held,
        });
        expect(builds).toBe(0);

        await indexCache.get({
          db: requestDb,
          source: "uk",
          edition: active("uk"),
        });
        expect(builds).toBe(1);
        await indexCache.refresh({
          db: requestDb,
          source: "uk",
          edition: held,
        });
        expect(builds).toBe(2);

        // The next check of the new edition answers from the prepared index.
        let reads = 0;
        const next = await indexCache.get({
          db: async (fn) => {
            reads += 1;
            return await requestDb(fn);
          },
          source: "uk",
          edition: held,
        });
        expect(next.isOk()).toBe(true);
        expect(reads).toBe(0);
        expect(builds).toBe(2);
      } finally {
        await clearHeldEdition("uk");
      }
    },
    DB_TEST_TIMEOUT_MS,
  );

  test("rejects a subject with no name letters before reading any list", async () => {
    let reads = 0;
    const result = await screenSanctionsSubject({
      db: async (fn) => {
        reads += 1;
        return await requestDb(fn);
      },
      subject: { type: "organization", name: "--- !!!", identifiers: [] },
      practiceJurisdictions: [],
      now: FRESH_NOW,
      indexCache: createSanctionsIndexCache(),
    });
    expect(result.isErr() && result.error.code).toBe("empty-query");
    expect(reads).toBe(0);
  });
});

test(
  "complete monitoring results include every hit beyond the interactive cap",
  async () => {
    const screened = await screenSanctionsSubject({
      db: requestDb,
      subject: {
        type: "organization",
        name: "Acme Trading Company",
        identifiers: [],
      },
      practiceJurisdictions: [],
      now: FRESH_NOW,
      resultMode: "complete",
    });
    expect(screened.isOk()).toBe(true);
    if (screened.isErr()) {
      return;
    }
    const list = screened.value.lists.find(({ source }) => source === "un");
    expect(list?.status).toBe("possible-match");
    expect(list?.truncated).toBe(false);
    expect(list?.possibleMatches).toHaveLength(TRUNCATED_ENTRIES);
  },
  DB_TEST_TIMEOUT_MS,
);

test.each(["missing", "extra"] as const)(
  "public screening reports %s edition entries for every registered source",
  async (mismatch) => {
    const logs = installRecordingLogger();
    const analytics = installRecordingAnalytics();
    resetFailureObservationsForTesting();
    const pool = createSanctionsMatcherPool({
      clock: createMatcherTestClock(),
    });
    const publicScreen = createPublicSanctionsScreening({
      pool,
      loadEntries: async (options) => {
        const entries = await loadEditionEntries(options);
        expect(entries).toHaveLength(options.edition.entryCount);
        return mismatch === "missing"
          ? entries.slice(0, -1)
          : entries.concat(entries);
      },
    });
    try {
      const outcome = (
        await publicScreen({
          db: requestDb,
          subject: {
            type: "organization",
            name: "Synthetic Company",
            identifiers: [],
          },
          practiceJurisdictions: [],
          now: FRESH_NOW,
        })
      ).unwrap();
      expect(outcome.status).toBe("unavailable");
      expect(
        outcome.lists.every(
          ({ status, reason }) =>
            status === "unavailable" && reason === "load-failed",
        ),
      ).toBe(true);
      const failures = logs.records.filter(
        ({ message }) => message === "sanctions.index_load_failed",
      );
      expect(failures).toHaveLength(sanctionsSourceIds().length);
      expect(
        new Set(failures.map(({ attributes }) => attributes["source"])),
      ).toEqual(new Set(sanctionsSourceIds()));
      for (const failure of failures) {
        expect(failure.severityText).toBe("ERROR");
        expect(failure.attributes).toMatchObject({
          stage: "short-read",
          feature: "sanctions.index_load",
          "failure.grade": "defect",
          "error.type": "SanctionsIndexLoadFailure",
        });
      }
      expect(analytics.exceptions()).toHaveLength(sanctionsSourceIds().length);
    } finally {
      await pool.close();
      logs.restore();
      analytics.restore();
      resetFailureObservationsForTesting();
    }
  },
);

test.each(["hang", "crash"])(
  "public worker %s never answers clear and recovers",
  async (fault) => {
    const warmupFinished = Promise.withResolvers<undefined>();
    const entered = Promise.withResolvers<undefined>();
    const crashed = Promise.withResolvers<undefined>();
    const { port1, port2 } = new MessageChannel();
    port1.once("message", () => entered.resolve(undefined));
    const clock = createMatcherTestClock();
    let spawned = 0;
    const pool = createSanctionsMatcherPool({
      deadlineMs: 200,
      clock,
      createWorker: () => {
        spawned += 1;
        const worker =
          spawned === 1
            ? new Worker(
                new URL(
                  "test-fixtures/matcher-fault-worker.ts",
                  import.meta.url,
                ),
                {
                  workerData: { fault, acknowledgement: port2 },
                  transferList: [port2],
                },
              )
            : new Worker(
                new URL("sanctions-matcher-worker.ts", import.meta.url),
              );
        if (spawned === 1) {
          worker.once("exit", () => crashed.resolve(undefined));
        }
        return worker;
      },
    });
    const publicScreen = createPublicSanctionsScreening({
      pool: {
        ...pool,
        run: async (work, options) => {
          const outcome = await pool.run(work, options);
          if (options?.onSettled !== undefined) {
            warmupFinished.resolve(undefined);
          }
          return outcome;
        },
      },
    });
    const props = {
      db: requestDb,
      subject: {
        type: "organization",
        name: "A Completely Distant Name",
        identifiers: [],
      },
      practiceJurisdictions: [],
      now: FRESH_NOW,
    } as const;
    try {
      const pending = publicScreen(props);
      await entered.promise;
      expect(clock.pending()).toEqual([200]);
      if (fault === "hang") {
        clock.advance(200);
      } else {
        await crashed.promise;
      }
      const first = (await pending).unwrap();
      expect(first.status).toBe("unavailable");
      expect(first.lists.every((list) => list.status === "unavailable")).toBe(
        true,
      );
      // Recovery is observed after its real background rebuild, independent of worker startup speed.
      await warmupFinished.promise;
      const next = (await publicScreen(props)).unwrap();
      expect(next.status).toBe("clear");
      expect(spawned).toBe(2);
    } finally {
      await pool.close();
      port1.close();
      port2.close();
    }
  },
);

test("repeated public deadlines bound unfinished cold loads until held reads settle", async () => {
  const logs = installRecordingLogger();
  const clock = createMatcherTestClock();
  const pool = createSanctionsMatcherPool({ size: 2, deadlineMs: 30, clock });
  const held = Promise.withResolvers<undefined>();
  const started = Promise.withResolvers<undefined>();
  let startedLoads = 0;
  let unfinished = 0;
  let peak = 0;
  let pagesAfterCancellation = 0;
  const publicScreen = createPublicSanctionsScreening({
    pool,
    loadEntries: async (options) => {
      startedLoads += 1;
      unfinished += 1;
      peak = Math.max(peak, unfinished);
      started.resolve(undefined);
      await held.promise;
      const entries = await loadEditionEntries({
        ...options,
        db: async (read) => {
          if (options.signal?.aborted) {
            pagesAfterCancellation += 1;
          }
          return await options.db(read);
        },
      });
      unfinished -= 1;
      return entries;
    },
  });
  const props = {
    db: requestDb,
    subject: {
      type: "organization",
      name: "Synthetic Company",
      identifiers: [],
    },
    practiceJurisdictions: [],
    now: FRESH_NOW,
  } as const;
  try {
    const first = publicScreen(props);
    await started.promise;
    expect(clock.pending()).toEqual([30]);
    clock.advance(30);
    expect((await first).unwrap().status).toBe("unavailable");
    for (const _attempt of Array.from({ length: 6 })) {
      const pending = publicScreen(props);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      clock.advance(30);
      expect((await pending).unwrap().status).toBe("unavailable");
    }
    // Both leases may share the same edition read; neither deadline releases it.
    expect(startedLoads).toBe(1);
    expect(unfinished).toBe(1);
    expect(peak).toBe(1);
    held.resolve(undefined);
    await pool.close();
    // Let the underlying operation (not just the deadline result) settle.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(unfinished).toBe(0);
    expect(pagesAfterCancellation).toBe(0);
    expect(
      logs.records.filter(
        ({ message }) => message === "sanctions.index_load_failed",
      ),
    ).toEqual([]);
  } finally {
    held.resolve(undefined);
    await pool.close();
    logs.restore();
  }
});
