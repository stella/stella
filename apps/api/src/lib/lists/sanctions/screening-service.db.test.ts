import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { MessageChannel, Worker } from "node:worker_threads";

import {
  buildScreeningIndex,
  SANCTIONS_SOURCES,
  screen,
  DEFAULT_CUTOFF,
  MAX_SCREENING_WORK,
} from "@stll/sanctions";
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
  signedInScreening,
  unavailableSanctionsScreening,
} from "@/api/lib/lists/sanctions/screening-service";
import type { SanctionsListOutcome } from "@/api/lib/lists/sanctions/screening-service";
import {
  SANCTIONS_SOURCE_CONFIG,
  sanctionsSourceIds,
} from "@/api/lib/lists/sanctions/source-config";
import { readEvidence } from "@/api/lib/observability/failure-evidence";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

import {
  createSanctionsMatcherPool,
  SANCTIONS_MATCHER_CONFIG,
} from "./matcher-pool";
import type { MatcherWorkOutcome } from "./matcher-pool";
import type { SanctionsMatcherSession } from "./matcher-pool-core";
import type {
  SanctionsMatcherMessage,
  SanctionsMatcherReply,
} from "./matcher-protocol";
import {
  createPublicSanctionsScreening,
  SANCTIONS_WARM_READ_STALL_MS,
  SANCTIONS_WARM_RETRY_MS,
  SANCTIONS_WARM_STALL_MS,
} from "./public-screening";
import type {
  reportSanctionsScreeningFailure,
  SanctionsMatcherFailureCause,
} from "./screening-failure";
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
          refresh: async () => {},
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
      const reports: Parameters<typeof reportSanctionsScreeningFailure>[0][] =
        [];
      const result = await screenSanctionsSubject({
        db: requestDb,
        reportFailure: (report) => {
          reports.push(report);
        },
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
      expect(reports).toEqual([
        { stage: "list-screening", reason: "index-load", source: "uk" },
      ]);
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

const publicProps = (name: string) =>
  ({
    db: requestDb,
    subject: { type: "organization", name, identifiers: [] },
    practiceJurisdictions: [],
    now: FRESH_NOW,
  }) as const;

const reasonsBySource = (lists: readonly SanctionsListOutcome[]) =>
  Object.fromEntries(lists.map(({ source, reason }) => [source, reason]));

test("a cold start converges when editions load for longer than any request deadline", async () => {
  const logs = installRecordingLogger();
  const clock = createMatcherTestClock();
  const pool = createSanctionsMatcherPool({ clock });
  const loadMs = 4000;
  // Reads start inside the first request's lease; they run slow only once it answered.
  const coldAnswered = Promise.withResolvers<undefined>();
  const publicScreen = createPublicSanctionsScreening({
    pool,
    clock,
    loadEntries: async (options) => {
      // Seven editions at four seconds each: far past the request deadline and
      // any total a single bounded warmup could take. No pending timer may fire.
      await coldAnswered.promise;
      clock.advance(loadMs);
      return await loadEditionEntries(options);
    },
  });
  const person = {
    ...publicProps("Ivan Petrovich Sidorov"),
    subject: {
      type: "person",
      name: "Ivan Petrovich Sidorov",
      birthDate: null,
      nationalityCodes: [],
    },
  } as const;
  try {
    const cold = (await publicScreen(person)).unwrap();
    coldAnswered.resolve(undefined);
    expect(cold.status).toBe("unavailable");
    expect(cold.lists.every(({ reason }) => reason === "warming")).toBe(true);
    await publicScreen.warmupSettled();
    expect(clock.now()).toBe(loadMs * sanctionsSourceIds().length);
    const warmed = logs.records.filter(
      ({ message }) => message === "sanctions.edition_warmed",
    );
    expect(warmed.map(({ attributes }) => attributes?.["durationMs"])).toEqual(
      sanctionsSourceIds().map(() => loadMs),
    );
    const warm = (await publicScreen(person)).unwrap();
    expect(warm.status).toBe("possible-match");
    expect(listOf(warm.lists, "eu").status).toBe("possible-match");
    expect(warm.lists.every(({ status }) => status !== "unavailable")).toBe(
      true,
    );
    expect(logs.at("ERROR")).toEqual([]);
  } finally {
    logs.restore();
    await pool.close();
  }
});

test("public screening refuses a pool whose workers could hold different indexes", async () => {
  const pool = createSanctionsMatcherPool({ size: 2 });
  try {
    expect(() => createPublicSanctionsScreening({ pool })).toThrow(
      "Public sanctions screening warms a single matcher worker",
    );
  } finally {
    await pool.close();
  }
});

test("concurrent cold requests share one warmup and its read never holds the matcher", async () => {
  const clock = createMatcherTestClock();
  const pool = createSanctionsMatcherPool({ clock });
  const gate = Promise.withResolvers<undefined>();
  const firstRead = Promise.withResolvers<undefined>();
  const leases = { requests: 0, warmups: 0 };
  let reads = 0;
  const publicScreen = createPublicSanctionsScreening({
    pool: {
      ...pool,
      run: async (work, options) => {
        if (options?.deadlineMs === SANCTIONS_WARM_STALL_MS) {
          leases.warmups += 1;
        } else {
          leases.requests += 1;
        }
        return await pool.run(work, options);
      },
    },
    clock,
    loadEntries: async (options) => {
      reads += 1;
      firstRead.resolve(undefined);
      await gate.promise;
      return await loadEditionEntries(options);
    },
  });
  try {
    // The first request meets a cold matcher and starts the only warmup.
    const opening = [await publicScreen(publicProps("First Distant Name"))];
    await firstRead.promise;
    // Public admission lets two requests in at once; three such rounds.
    const during: Awaited<ReturnType<typeof publicScreen>>[] = [];
    for (const round of [0, 1, 2]) {
      during.push(
        ...(await Promise.all(
          [0, 1].map(
            async (index) =>
              await publicScreen(publicProps(`Distant Name ${round}${index}`)),
          ),
        )),
      );
    }
    for (const answer of [...opening, ...during]) {
      expect(
        answer.unwrap().lists.every(({ reason }) => reason === "warming"),
      ).toBe(true);
    }
    expect(reads).toBe(1);
    // Requests kept the matcher while the read ran; none started a warmup.
    expect(leases).toEqual({ requests: 7, warmups: 0 });
    gate.resolve(undefined);
    await publicScreen.warmupSettled();
    expect(reads).toBe(sanctionsSourceIds().length);
    expect(leases.warmups).toBe(sanctionsSourceIds().length);
    const warm = (
      await publicScreen(publicProps("Third Distant Name"))
    ).unwrap();
    expect(warm.status).toBe("clear");
    expect(reads).toBe(sanctionsSourceIds().length);
  } finally {
    gate.resolve(undefined);
    await pool.close();
  }
});

test("loaded lists keep screening while another edition reloads behind a held read", async () => {
  const clock = createMatcherTestClock();
  const pool = createSanctionsMatcherPool({ clock });
  const reloading: SanctionsSource = "uk";
  const gate = Promise.withResolvers<undefined>();
  const held = Promise.withResolvers<undefined>();
  const evicted = { current: false };
  const publicScreen = createPublicSanctionsScreening({
    pool: {
      ...pool,
      run: async (work, options) =>
        await pool.run(
          async (session) =>
            await work({
              ...session,
              // As if a newer edition replaced the loaded one.
              hasEdition: (source, editionId) =>
                !(evicted.current && source === reloading) &&
                session.hasEdition(source, editionId),
            }),
          options,
        ),
    },
    clock,
    loadEntries: async (options) => {
      const entries = await loadEditionEntries(options);
      if (evicted.current && entries.at(0)?.source === reloading) {
        held.resolve(undefined);
        await gate.promise;
      }
      return entries;
    },
  });
  const person = {
    ...publicProps("Ivan Petrovich Sidorov"),
    subject: {
      type: "person",
      name: "Ivan Petrovich Sidorov",
      birthDate: null,
      nationalityCodes: [],
    },
  } as const;
  try {
    await publicScreen(person);
    await publicScreen.warmupSettled();
    evicted.current = true;
    expect(
      reasonsBySource((await publicScreen(person)).unwrap().lists)[reloading],
    ).toBe("warming");
    await held.promise;
    for (const _attempt of Array.from({ length: 3 })) {
      const during = (await publicScreen(person)).unwrap();
      expect(listOf(during.lists, "eu").status).toBe("possible-match");
      expect(reasonsBySource(during.lists)).toEqual({
        ...Object.fromEntries(
          sanctionsSourceIds().map((source) => [source, null]),
        ),
        [reloading]: "warming",
      });
    }
    evicted.current = false;
    gate.resolve(undefined);
    await publicScreen.warmupSettled();
    const after = (await publicScreen(person)).unwrap();
    expect(after.lists.every(({ status }) => status !== "unavailable")).toBe(
      true,
    );
  } finally {
    gate.resolve(undefined);
    await pool.close();
  }
});

test("a stalled read that ignores cancellation is never repeated and the editions behind it still load", async () => {
  const clock = createMatcherTestClock();
  const pool = createSanctionsMatcherPool({ clock });
  const reports: Parameters<typeof reportSanctionsScreeningFailure>[0][] = [];
  const stalling: SanctionsSource = "us-sdn";
  const started = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const landed = Promise.withResolvers<undefined>();
  const signals: AbortSignal[] = [];
  const reads = { started: 0, outstanding: 0, peak: 0 };
  const publicScreen = createPublicSanctionsScreening({
    pool,
    clock,
    reportFailure: (report) => {
      reports.push(report);
    },
    loadEntries: async (options) => {
      if (options.edition.id !== editionIds.get(stalling)) {
        return await loadEditionEntries(options);
      }
      reads.started += 1;
      reads.outstanding += 1;
      reads.peak = Math.max(reads.peak, reads.outstanding);
      signals.push(options.signal ?? panic("A warmup read needs a signal"));
      started.resolve(undefined);
      // Ignores its abort signal, like a driver call already on the wire.
      await release.promise;
      const entries = await loadEditionEntries({
        db: options.db,
        edition: options.edition,
      });
      reads.outstanding -= 1;
      landed.resolve(undefined);
      return entries;
    },
  });
  const ask = async () =>
    (await publicScreen(publicProps("A Completely Distant Name"))).unwrap();
  try {
    await ask();
    await started.promise;
    const behind = sanctionsSourceIds().slice(
      sanctionsSourceIds().indexOf(stalling) + 1,
    );
    expect(behind.length).toBeGreaterThan(0);
    const waiting = reasonsBySource((await ask()).lists);
    for (const source of [stalling, ...behind]) {
      expect(waiting[source]).toBe("warming");
    }
    expect(clock.pending()).toEqual([SANCTIONS_WARM_READ_STALL_MS]);
    clock.advance(SANCTIONS_WARM_READ_STALL_MS);
    await publicScreen.warmupSettled();
    expect(signals.at(0)?.aborted).toBe(true);
    expect(reasonsBySource((await ask()).lists)).toEqual({
      ...Object.fromEntries(
        sanctionsSourceIds().map((source) => [source, null]),
      ),
      [stalling]: "load-failed",
    });
    // Retries wait on the same unfinished read instead of starting another.
    for (const wait of [
      SANCTIONS_WARM_RETRY_MS.initial,
      SANCTIONS_WARM_RETRY_MS.initial * 2,
    ]) {
      clock.advance(wait);
      expect(reasonsBySource((await ask()).lists)[stalling]).toBe("warming");
      clock.advance(SANCTIONS_WARM_READ_STALL_MS);
      await publicScreen.warmupSettled();
    }
    expect(reads).toEqual({ started: 1, outstanding: 1, peak: 1 });
    expect(
      reports.map(({ stage, reason, source }) => ({ stage, reason, source })),
    ).toEqual(
      Array.from({ length: 3 }, () => ({
        stage: "public-warmup",
        reason: "read-stalled",
        source: stalling,
      })),
    );
    // The read lands during the backoff; the next attempt takes its entries.
    release.resolve(undefined);
    await landed.promise;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    clock.advance(SANCTIONS_WARM_RETRY_MS.initial * 4);
    await ask();
    await publicScreen.warmupSettled();
    expect((await ask()).status).toBe("clear");
    expect(reads).toEqual({ started: 1, outstanding: 0, peak: 1 });
  } finally {
    release.resolve(undefined);
    await pool.close();
  }
});

test.each(["entries-read", "short-read"] as const)(
  "one list failing on %s does not block the other six and retries with backoff",
  async (fault) => {
    const clock = createMatcherTestClock();
    const pool = createSanctionsMatcherPool({ clock });
    const reports: Parameters<typeof reportSanctionsScreeningFailure>[0][] = [];
    const reads = new Map<SanctionsSource, number>();
    const failing: SanctionsSource = "uk";
    const publicScreen = createPublicSanctionsScreening({
      pool,
      clock,
      reportFailure: (report) => {
        reports.push(report);
      },
      loadEntries: async (options) => {
        const entries = await loadEditionEntries(options);
        const source = entries.at(0)?.source ?? panic("Missing fixture entry");
        const attempt = (reads.get(source) ?? 0) + 1;
        reads.set(source, attempt);
        if (source === failing && attempt <= 2) {
          if (fault === "entries-read") {
            throw new TypeError("Private Test Identity");
          }
          return entries.slice(1);
        }
        return entries;
      },
    });
    const ask = async () =>
      (await publicScreen(publicProps("A Completely Distant Name"))).unwrap();
    const failures = () =>
      reports.map(({ stage, reason, source }) => ({ stage, reason, source }));
    const others = Object.fromEntries(
      sanctionsSourceIds()
        .filter((source) => source !== failing)
        .map((source) => [source, null]),
    );
    try {
      await ask();
      await publicScreen.warmupSettled();
      expect(reasonsBySource((await ask()).lists)).toEqual({
        ...others,
        [failing]: "load-failed",
      });
      // Waiting out the backoff answers from the other lists without new reports.
      expect(reasonsBySource((await ask()).lists)).toEqual({
        ...others,
        [failing]: "load-failed",
      });
      expect(failures()).toEqual([
        { stage: "public-warmup", reason: fault, source: failing },
      ]);
      clock.advance(SANCTIONS_WARM_RETRY_MS.initial - 1);
      expect(reasonsBySource((await ask()).lists)[failing]).toBe("load-failed");
      clock.advance(1);
      expect(reasonsBySource((await ask()).lists)[failing]).toBe("warming");
      await publicScreen.warmupSettled();
      expect(failures()).toHaveLength(2);
      // The second failure doubles the wait.
      clock.advance(SANCTIONS_WARM_RETRY_MS.initial);
      expect(reasonsBySource((await ask()).lists)[failing]).toBe("load-failed");
      clock.advance(SANCTIONS_WARM_RETRY_MS.initial);
      expect(reasonsBySource((await ask()).lists)[failing]).toBe("warming");
      await publicScreen.warmupSettled();
      const recovered = await ask();
      expect(recovered.status).toBe("clear");
      expect(failures()).toHaveLength(2);
      expect(Object.fromEntries(reads)).toEqual({
        ...Object.fromEntries(Object.keys(others).map((source) => [source, 1])),
        [failing]: 3,
      });
      expect(JSON.stringify(reports)).not.toContain(
        "A Completely Distant Name",
      );
    } finally {
      await pool.close();
    }
  },
);

test.each(["hang", "crash"] as const)(
  "a worker %s while loading fails only its edition and never answers clear",
  async (fault) => {
    const entered = Promise.withResolvers<undefined>();
    const crashed = Promise.withResolvers<undefined>();
    const { port1, port2 } = new MessageChannel();
    port1.once("message", () => {
      entered.resolve(undefined);
    });
    const clock = createMatcherTestClock();
    const reports: Parameters<typeof reportSanctionsScreeningFailure>[0][] = [];
    let spawned = 0;
    const pool = createSanctionsMatcherPool({
      clock,
      createWorker: () => {
        spawned += 1;
        if (spawned > 1) {
          return new Worker(
            new URL("sanctions-matcher-worker.ts", import.meta.url),
          );
        }
        const worker = new Worker(
          new URL("test-fixtures/matcher-fault-worker.ts", import.meta.url),
          {
            workerData: { fault, acknowledgement: port2 },
            transferList: [port2],
          },
        );
        worker.once("exit", () => {
          crashed.resolve(undefined);
        });
        return worker;
      },
    });
    const publicScreen = createPublicSanctionsScreening({
      pool,
      clock,
      reportFailure: (report) => {
        reports.push(report);
      },
    });
    const ask = async () =>
      (await publicScreen(publicProps("A Completely Distant Name"))).unwrap();
    try {
      expect((await ask()).status).toBe("unavailable");
      await entered.promise;
      if (fault === "hang") {
        // Only the stall limit frees a hung worker; a request deadline never does.
        expect(clock.pending()).toEqual([SANCTIONS_WARM_STALL_MS]);
        clock.advance(SANCTIONS_WARM_STALL_MS);
      } else {
        await crashed.promise;
      }
      await publicScreen.warmupSettled();
      const partial = await ask();
      const failed = partial.lists.filter(
        ({ status }) => status === "unavailable",
      );
      expect(failed.map(({ reason }) => reason)).toEqual(["load-failed"]);
      expect(
        partial.lists.filter(({ status }) => status === "clear"),
      ).toHaveLength(sanctionsSourceIds().length - 1);
      expect(reports).toMatchObject([
        {
          stage: "public-warmup",
          reason: fault === "hang" ? "deadline" : "worker-exit",
          source: failed.at(0)?.source,
        },
      ]);
      clock.advance(SANCTIONS_WARM_RETRY_MS.initial);
      expect((await ask()).status).toBe("unavailable");
      await publicScreen.warmupSettled();
      expect((await ask()).status).toBe("clear");
      expect(spawned).toBe(2);
    } finally {
      await pool.close();
      port1.close();
      port2.close();
    }
  },
);

test.each(["matcher-unavailable", "operation", "truncated-empty"] as const)(
  "list fallback reports %s and never reports a clear result",
  async (reason) => {
    const reports: Parameters<typeof reportSanctionsScreeningFailure>[0][] = [];
    const result = await screenSanctionsSubject({
      db: requestDb,
      subject: {
        type: "organization",
        name: "Private Test Identity",
        identifiers: [],
      },
      practiceJurisdictions: [],
      now: FRESH_NOW,
      reportFailure: (report) => {
        reports.push(report);
      },
      matcher: async ({ query }) => {
        if (reason === "matcher-unavailable") {
          return Result.err({
            code: "load-failed",
            stage: "list-screening",
            reason,
          } as const);
        }
        if (reason === "operation") {
          throw new TypeError("Private Test Identity");
        }
        return Result.ok({
          ...screen(buildScreeningIndex([]), query, {
            cutoff: DEFAULT_CUTOFF,
          }).unwrap(),
          truncated: true,
        });
      },
    });
    expect(
      result
        .unwrap()
        .lists.every(
          (list) =>
            list.status === "unavailable" && list.reason === "load-failed",
        ),
    ).toBe(true);
    expect(
      reports.map(({ stage, reason: cause, source }) => ({
        stage,
        reason: cause,
        source,
      })),
    ).toEqual(
      result.unwrap().lists.map(({ source }) => ({
        stage: "list-screening",
        reason,
        source,
      })),
    );
  },
);

test("freshness read fallback observes its cause before answering all lists unavailable", async () => {
  const fault = Object.assign(new TypeError("Private Test Identity"), {
    code: "42501",
  });
  const reports: Parameters<typeof reportSanctionsScreeningFailure>[0][] = [];
  const result = await screenSanctionsSubject({
    db: async () => {
      throw fault;
    },
    subject: {
      type: "organization",
      name: "Private Test Identity",
      identifiers: [],
    },
    practiceJurisdictions: [],
    reportFailure: (report) => {
      reports.push(report);
    },
  });
  expect(
    result
      .unwrap()
      .lists.every(
        (list) =>
          list.status === "unavailable" && list.reason === "load-failed",
      ),
  ).toBe(true);
  expect(reports).toHaveLength(1);
  expect(reports.at(0)).toMatchObject({
    stage: "whole-screening",
    reason: "freshness-read",
  });
  expect(
    readEvidence(reports.at(0)?.error).nodes.some(
      ({ code }) => code === "42501",
    ),
  ).toBe(true);
});

test("work exhaustion reports its actual list cause once rather than counting an index failure", async () => {
  const reports: Parameters<typeof reportSanctionsScreeningFailure>[0][] = [];
  const healthy = createSanctionsIndexCache();
  const result = await screenSanctionsSubject({
    db: requestDb,
    subject: {
      type: "organization",
      name: "Blue Meadow Bakery",
      identifiers: ["12345"],
    },
    practiceJurisdictions: [],
    now: FRESH_NOW,
    reportFailure: (report) => {
      reports.push(report);
    },
    indexCache: {
      get: async (props) => {
        const loaded = await healthy.get(props);
        if (loaded.isErr() || props.source !== "eu") {
          return loaded;
        }
        const index = {
          ...loaded.value,
          identifierEntries: new Map([
            ["12345", Array.from({ length: MAX_SCREENING_WORK + 1 }, () => 0)],
          ]),
        };
        const reached = screen(
          index,
          {
            name: "Blue Meadow Bakery",
            entityType: "organisation",
            identifiers: ["12345"],
          },
          { cutoff: DEFAULT_CUTOFF },
        );
        expect(reached.isErr() && reached.error.code).toBe("work-limit");
        return Result.ok(index);
      },
      refresh: async () => {},
    },
  });
  expect(listOf(result.unwrap().lists, "eu")).toMatchObject({
    status: "unavailable",
    reason: "load-failed",
  });
  expect(reports).toEqual([
    { stage: "list-screening", reason: "work-limit", source: "eu" },
  ]);
});

test("public matcher work exhaustion reports the typed list cause without pool failure or warmup", async () => {
  const poolReports: Parameters<typeof reportSanctionsScreeningFailure>[0][] =
    [];
  const reports: Parameters<typeof reportSanctionsScreeningFailure>[0][] = [];
  const pool = createSanctionsMatcherPool({
    clock: createMatcherTestClock(),
    reportFailure: (report) => {
      poolReports.push(report);
    },
  });
  let leases = 0;
  const publicScreen = createPublicSanctionsScreening({
    reportFailure: (report) => {
      reports.push(report);
    },
    pool: {
      ...pool,
      run: async (work, options) => {
        leases += 1;
        return await pool.run(
          async (session) =>
            await work({
              ...session,
              hasEdition: () => true,
              match: async () => ({ status: "work-limit" }),
            }),
          options,
        );
      },
    },
    loadEntries: async () => {
      throw new TypeError("A cached edition must not reload");
    },
  });
  try {
    const result = await publicScreen({
      db: requestDb,
      subject: {
        type: "organization",
        name: "Synthetic Company",
        identifiers: [],
      },
      practiceJurisdictions: [],
      now: FRESH_NOW,
    });
    expect(
      result
        .unwrap()
        .lists.every(
          (list) =>
            list.status === "unavailable" && list.reason === "load-failed",
        ),
    ).toBe(true);
    expect(reports).toEqual(
      result.unwrap().lists.map(({ source }) => ({
        stage: "public-matcher",
        reason: "work-limit",
        error: undefined,
        source,
      })),
    );
    expect(poolReports).toEqual([]);
    expect(leases).toBe(1);
  } finally {
    await pool.close();
  }
});

const boundaryFaults = {
  "worker-create": "worker-create",
  "worker-error": "worker-error",
  "worker-exit": "worker-exit",
  "worker-send": "worker-send",
  "worker-reply": "worker-reply",
  operation: "operation",
  "worker-retire": "worker-retire",
  deadline: "deadline",
  closed: "closed",
  admission: "admission",
  "work-limit": "work-limit",
} as const satisfies {
  [Cause in SanctionsMatcherFailureCause | "work-limit"]: Cause;
};

test.each(Object.values(boundaryFaults))(
  "public boundary owns capture for %s and canceled work emits no later reports",
  async (fault) => {
    const logs = installRecordingLogger();
    const analytics = installRecordingAnalytics();
    const clock = createMatcherTestClock();
    const held = Promise.withResolvers<undefined>();
    const started = Promise.withResolvers<undefined>();
    const settled = Promise.withResolvers<undefined>();
    const cause = new TypeError("Boundary fault sentinel");
    const workers: EventEmitter[] = [];
    let creations = 0;
    const pool = createSanctionsMatcherPool({
      size: 1,
      clock,
      createWorker: () => {
        creations += 1;
        if (fault === "worker-create" && creations === 1) {
          throw cause;
        }
        // oxlint-disable-next-line unicorn/prefer-event-target -- Implements node Worker on/once/off for deterministic fault delivery.
        const worker = new EventEmitter();
        workers.push(worker);
        return asTestRaw<Worker>(
          Object.assign(worker, {
            unref: () => {},
            terminate: async () => {
              if (fault === "worker-retire") {
                throw cause;
              }
              return 0;
            },
            postMessage: (message: SanctionsMatcherMessage) => {
              if (fault === "deadline" || fault === "closed") {
                // Owe the reply: the lease ends by its deadline or by closing.
                started.resolve(undefined);
                return;
              }
              if (fault === "worker-send") {
                throw cause;
              }
              if (fault === "worker-error") {
                worker.emit("error", cause);
                return;
              }
              if (fault === "worker-exit") {
                worker.emit("exit", 1);
                return;
              }
              if (fault === "worker-reply") {
                worker.emit("message", {
                  status: "unavailable",
                } satisfies SanctionsMatcherReply);
                return;
              }
              const response =
                message.type === "entries"
                  ? ({ status: "entries-loaded" } as const)
                  : ({ status: "work-limit" } as const);
              worker.emit("message", response satisfies SanctionsMatcherReply);
            },
          }),
        );
      },
    });
    const blockers: Promise<unknown>[] = [];
    if (fault === "admission") {
      for (const _slot of Array.from({ length: 3 })) {
        blockers.push(
          pool.run(async () => {
            await held.promise;
            return null;
          }),
        );
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
    }
    const publicScreen = createPublicSanctionsScreening({
      pool: {
        ...pool,
        run: async <T>(
          work: (session: SanctionsMatcherSession) => Promise<T>,
          options?: { deadlineMs?: number; onSettled?: () => void },
        ): Promise<MatcherWorkOutcome<T>> => {
          // Isolate foreground reporting from the separately tested warmup:
          // its lease settles as loaded, which is the value its caller
          // expects but cannot be typed against `T` here.
          if (options?.deadlineMs === SANCTIONS_WARM_STALL_MS) {
            return asTestRaw<MatcherWorkOutcome<T>>({
              status: "completed",
              value: Result.ok(undefined),
            });
          }
          return await pool.run(
            async (session) => {
              if (fault === "operation" || fault === "worker-retire") {
                throw cause;
              }
              // Warm editions: the request itself reaches the worker.
              return await work({ ...session, hasEdition: () => true });
            },
            {
              onSettled: () => {
                settled.resolve(undefined);
              },
            },
          );
        },
      },
    });
    try {
      const pending = publicScreen({
        db: requestDb,
        subject: {
          type: "organization",
          name: "Synthetic Company",
          identifiers: [],
        },
        practiceJurisdictions: [],
        now: FRESH_NOW,
      });
      if (fault === "deadline" || fault === "closed") {
        await started.promise;
        if (fault === "deadline") {
          clock.advance(SANCTIONS_MATCHER_CONFIG.deadlineMs);
        } else {
          await pool.close();
        }
      }
      const result = (await pending).unwrap();
      expect(result.status).toBe("unavailable");
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      const expectedCaptures = [
        "deadline",
        "closed",
        "admission",
        "work-limit",
      ].some((anticipated) => anticipated === fault)
        ? 0
        : 1;
      expect(analytics.exceptions()).toHaveLength(expectedCaptures);
      expect(logs.at("ERROR")).toHaveLength(expectedCaptures);
      const boundary = logs.records.filter(
        ({ message }) => message === "sanctions.screening_failed",
      );
      expect(boundary.length).toBeGreaterThan(0);
      if (
        [
          "worker-create",
          "worker-error",
          "worker-send",
          "operation",
          "worker-retire",
        ].some((withCause) => withCause === fault)
      ) {
        expect(
          boundary.some(({ attributes }) =>
            Object.values(attributes ?? {}).includes("TypeError"),
          ),
        ).toBe(true);
      }
      expect(
        boundary.every(
          ({ attributes }) =>
            attributes?.["failure.grade"] ===
            (expectedCaptures === 0 ? "anticipated" : "defect"),
        ),
      ).toBe(true);
      const count = logs.records.length;
      held.resolve(undefined);
      await settled.promise;
      await Promise.all(blockers);
      if (fault !== "worker-create") {
        workers.at(0)?.emit("error", cause);
        workers.at(0)?.emit("exit", 1);
      }
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      if (fault !== "work-limit" && fault !== "admission") {
        expect(logs.records).toHaveLength(count);
      }
      expect(
        JSON.stringify({ logs: logs.records, analytics: analytics.events }),
      ).not.toContain(cause.message);
    } finally {
      held.resolve(undefined);
      await pool.close();
      logs.restore();
      analytics.restore();
    }
  },
);

test("signed-in screenings pass through every reason but warming, which is a defect", () => {
  for (const reason of [
    "not-loaded",
    "load-failed",
    "company-not-found",
  ] as const) {
    const screening = unavailableSanctionsScreening({
      reason,
      practiceJurisdictions: [],
      now: FRESH_NOW,
    });
    expect(signedInScreening(screening)).toEqual(screening);
  }
  expect(() =>
    signedInScreening(
      unavailableSanctionsScreening({
        reason: "warming",
        practiceJurisdictions: [],
        now: FRESH_NOW,
      }),
    ),
  ).toThrow("A signed-in sanctions screening reported a warming list");
});
