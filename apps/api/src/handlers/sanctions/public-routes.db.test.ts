import { Value } from "@sinclair/typebox/value";
import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, getTableName, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";

import { chunk as chunkItems } from "@stll/concurrency/chunk";
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
import { markRlsDatabase } from "@/api/db/scoped";
import { createPublicSanctionsRoute } from "@/api/handlers/sanctions/public-routes";
import { publicSanctionsResponseSchema } from "@/api/handlers/sanctions/search-response";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { toSafeId } from "@/api/lib/branded-types";
import { runEntityCheckShared } from "@/api/lib/business-registries/entity-checks";
import type { CounterpartyCheckSubject } from "@/api/lib/business-registries/entity-checks";
import { createSanctionsMatcherPool } from "@/api/lib/lists/sanctions/matcher-pool";
import type { SanctionsMatcherMessage } from "@/api/lib/lists/sanctions/matcher-protocol";
import {
  createPublicSanctionsScreening,
  SANCTIONS_WARMING_RETRY_AFTER_SECONDS,
} from "@/api/lib/lists/sanctions/public-screening";
import { createSanctionsPublicReadDb } from "@/api/lib/lists/sanctions/read-db";
import type { SanctionsPublicReadDb } from "@/api/lib/lists/sanctions/read-db";
import {
  createSanctionsIndexCache,
  loadEditionEntries,
} from "@/api/lib/lists/sanctions/screening-index";
import {
  SANCTIONS_MATCH_LIMIT,
  screenSanctionsSubject,
} from "@/api/lib/lists/sanctions/screening-service";
import {
  SANCTIONS_SOURCE_CONFIG,
  sanctionsSourceIds,
} from "@/api/lib/lists/sanctions/source-config";
import { recordingMatcherWorker } from "@/api/lib/lists/sanctions/test-fixtures/recording-matcher-worker";
import {
  InMemoryRateLimitContext,
  scopedGenerator,
} from "@/api/lib/rate-limit/rate-limit";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const DB_TEST_TIMEOUT_MS = 120_000;
const VERIFIED_AT = new Date("2026-09-20T08:00:00Z");
const FRESH_NOW = new Date("2026-09-20T09:00:00Z");
const STALE_NOW = new Date("2026-09-23T08:00:00Z");
const MANY_MATCHES = SANCTIONS_MATCH_LIMIT + 5;
const BENCHMARK_ENTRY_COUNT = 20_000;
const INSERT_BATCH_SIZE = 100;

const pools = new Set<ReturnType<typeof createSanctionsMatcherPool>>();
const benchmarkPool = () => {
  const pool = createSanctionsMatcherPool({ deadlineMs: 10_000 });
  pools.add(pool);
  return pool;
};

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let publicDb: SanctionsPublicReadDb;
let requestDb: ScopedDb;
const editionIds = new Map<
  SanctionsSource,
  ReturnType<typeof toSafeId<"sanctionsEdition">>
>();

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

type EntryOptions = {
  source: SanctionsSource;
  sourceId: string;
  overrides?: Partial<SanctionsEntry>;
};

const entry = ({
  source,
  sourceId,
  overrides,
}: EntryOptions): SanctionsEntry => ({
  source,
  issuer: SANCTIONS_SOURCES[source].issuer,
  sourceId,
  referenceNumber: null,
  entityType: "organisation",
  names: [
    { name: `Distant Registered Enterprise ${sourceId}`, quality: "strong" },
  ],
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
  const base = entry({ source, sourceId: "base" });
  if (source === "eu") {
    return [
      base,
      entry({
        source,
        sourceId: "czech-person",
        overrides: {
          entityType: "person",
          names: [{ name: "Čeněk Říha", quality: "strong" }],
        },
      }),
      entry({
        source,
        sourceId: "person",
        overrides: {
          entityType: "person",
          names: [{ name: "Ivan Petrovich Sidorov", quality: "strong" }],
          birthDates: [
            { precision: "day", year: 1960, month: 5, day: 12, circa: false },
          ],
          nationalities: [{ code: "RU", name: "Russia" }],
        },
      }),
    ];
  }
  if (source === "un") {
    return [
      base,
      ...Array.from({ length: MANY_MATCHES }, (_, index) =>
        entry({
          source,
          sourceId: `organization-${index}`,
          overrides: {
            names: [{ name: "Acme Trading Company", quality: "strong" }],
          },
        }),
      ),
    ];
  }
  return [base];
};

const activeEdition = (source: SanctionsSource) => {
  const id = editionIds.get(source);
  if (id === undefined) {
    return panic("Missing fixture edition");
  }
  return id;
};

const seedEntries = async (
  source: SanctionsSource,
  entries: SanctionsEntry[],
) => {
  for (const batch of chunkItems(entries, INSERT_BATCH_SIZE)) {
    await db.insert(sanctionsEntryPayloads).values(
      batch.map((payload) => ({
        contentHash: hash(JSON.stringify(payload)),
        payload,
      })),
    );
    await db.insert(sanctionsEditionEntries).values(
      batch.map((payload) => ({
        editionId: activeEdition(source),
        sourceEntryId: payload.sourceId,
        contentHash: hash(JSON.stringify(payload)),
      })),
    );
  }
};

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  publicDb = createSanctionsPublicReadDb(
    markRlsDatabase({
      transaction: async (fn) =>
        await db.transaction(
          async (tx) => await fn(asTestRaw<Transaction>(tx)),
        ),
    }),
  );
  requestDb = async (fn) =>
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE stella`);
      return await fn(asTestRaw<Transaction>(tx));
    });
  for (const source of sanctionsSourceIds()) {
    const id = toSafeId<"sanctionsEdition">(Bun.randomUUIDv7());
    editionIds.set(source, id);
    const entries = entriesFor(source);
    await db.insert(sanctionsSources).values({
      id: source,
      issuer: SANCTIONS_SOURCE_CONFIG[source].issuer,
      markerUrl: SANCTIONS_SOURCE_CONFIG[source].markerUrl,
    });
    await db.insert(sanctionsEditions).values({
      id,
      sourceId: source,
      markerKey: hash(`${source}:marker`),
      publishedAt: "2026-09-19",
      fileId: null,
      contentHash: hash(`${source}:content`),
      entryCount: entries.length,
      state: "ready",
      activatedAt: VERIFIED_AT,
    });
    await seedEntries(source, entries);
    await db
      .update(sanctionsSources)
      .set({
        activeEditionId: id,
        lastCheckedAt: VERIFIED_AT,
        lastSuccessfulVerifiedAt: VERIFIED_AT,
      })
      .where(eq(sanctionsSources.id, source));
  }
}, DB_TEST_TIMEOUT_MS);

afterAll(async () => {
  await Promise.all([...pools].map(async (pool) => await pool.close()));
  await client.close();
});

type NameSubject = Extract<
  CounterpartyCheckSubject,
  { type: "person" | "organization" }
>;
type ParityOptions = {
  subject: NameSubject;
  now?: Date;
  publicResponse?: Response;
  caches?: {
    product: ReturnType<typeof createSanctionsIndexCache>;
    public: ReturnType<typeof createSanctionsMatcherPool>;
  };
};

const publicWireSubject = (subject: NameSubject) =>
  subject.type === "organization"
    ? {
        type: subject.type,
        name: subject.name,
        ...(subject.companyId !== null && { companyId: subject.companyId }),
      }
    : {
        type: subject.type,
        firstName: subject.firstName,
        lastName: subject.lastName,
        ...(subject.dateOfBirth !== null && {
          dateOfBirth: subject.dateOfBirth,
        }),
        nationalityCodes: subject.nationalityCodes,
      };

/** A cold public screening answers "warming"; settle its one background warmup. */
const warmPublicScreen = async (
  publicScreen: ReturnType<typeof createPublicSanctionsScreening>,
  now: Date,
) => {
  const cold = (
    await publicScreen({
      db: publicDb,
      now,
      practiceJurisdictions: [],
      subject: { type: "organization", name: "Warmup", identifiers: [] },
    })
  ).unwrap();
  expect(cold.lists.some(({ reason }) => reason === "warming")).toBe(true);
  await publicScreen.warmupSettled();
};

const assertParity = async ({
  subject,
  now = FRESH_NOW,
  caches,
  publicResponse,
}: ParityOptions) => {
  // Separate caches ensure both access boundaries load the corpus themselves.
  const productCache = caches?.product ?? createSanctionsIndexCache();
  const publicPool = caches?.public ?? benchmarkPool();
  const inProduct = (
    await runEntityCheckShared({
      observer: "unobserved",
      permit: grantThirdPartyOutboundPermit(),
      check: "sanctions",
      subject,
      sanctions: {
        scopedDb: requestDb,
        organizationId: toSafeId<"organization">(
          "00000000-0000-4000-8000-000000000001",
        ),
        loadPracticeJurisdictions: async () => ["CZ"],
        screen: async (props) =>
          await screenSanctionsSubject({
            ...props,
            now,
            indexCache: productCache,
          }),
      },
    })
  ).unwrap();
  if (inProduct.kind !== "sanctions") {
    return panic("Expected sanctions check");
  }
  const { kind, subject: checkedSubject, ...screening } = inProduct;
  expect(kind).toBe("sanctions");
  expect(checkedSubject.type).toBe(subject.type);
  const publicScreen = createPublicSanctionsScreening({ pool: publicPool });
  if (publicResponse === undefined) {
    await warmPublicScreen(publicScreen, now);
  }
  const analytics = installRecordingAnalytics();
  const logger = installRecordingLogger();
  const context = new InMemoryRateLimitContext();
  const route = createPublicSanctionsRoute({
    db: publicDb,
    now,
    screen: publicScreen,
    rateLimitOptions: {
      context,
      generator: scopedGenerator("parity-test"),
      duration: 60_000,
      max: 1000,
    },
  });
  const wireSubject = publicWireSubject(subject);
  try {
    const response =
      publicResponse ??
      (await route.handle(
        new Request("http://localhost/sanctions/search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ subject: wireSubject }),
        }),
      ));
    expect(response.status).toBe(200);
    const body = Value.Decode(
      publicSanctionsResponseSchema[200],
      await response.json(),
    );
    expect([...Value.Errors(publicSanctionsResponseSchema[200], body)]).toEqual(
      [],
    );
    expect(JSON.stringify(body)).not.toContain("UnmatchedPrivateIdentityQxzv");
    if (publicResponse === undefined) {
      expect(JSON.stringify(analytics.events)).not.toContain(
        "UnmatchedPrivateIdentityQxzv",
      );
      expect(JSON.stringify(logger.records)).not.toContain(
        "UnmatchedPrivateIdentityQxzv",
      );
      expect(JSON.stringify(analytics.events)).not.toContain("Ivan Sidorov");
      expect(JSON.stringify(logger.records)).not.toContain("Ivan Sidorov");
    }
    expect(body).toEqual({
      ...screening,
      retryAfterSeconds: null,
      lists: inProduct.lists.map((list) => ({
        ...list,
        classification: "informational",
      })),
    });
    expect(inProduct.lists.map(({ source }) => source).toSorted()).toEqual(
      sanctionsSourceIds().toSorted(),
    );
    expect(
      inProduct.lists.find(({ source }) => source === "eu")?.classification,
    ).toBe("binding");
    return inProduct;
  } finally {
    context.kill();
    analytics.restore();
    logger.restore();
    if (caches === undefined) {
      await publicPool.close();
      pools.delete(publicPool);
    }
  }
};

const clearSubject = {
  type: "organization",
  name: "UnmatchedPrivateIdentityQxzv",
  companyId: null,
} as const satisfies NameSubject;

const exerciseColdWarmup = async (size: 1 | 2) => {
  const messages: SanctionsMatcherMessage[] = [];
  class RecordingWorker extends Worker {
    constructor() {
      super(
        new URL(
          "../../lib/lists/sanctions/sanctions-matcher-worker.ts",
          import.meta.url,
        ),
      );
    }
    override postMessage(...args: Parameters<Worker["postMessage"]>) {
      messages.push(asTestRaw<SanctionsMatcherMessage>(args[0]));
      super.postMessage(...args);
    }
  }
  const pool = createSanctionsMatcherPool({
    size,
    deadlineMs: 250,
    createWorker: () => new RecordingWorker(),
  });
  let reads = 0;
  const publicScreen = createPublicSanctionsScreening({
    pool,
    loadEntries: async (options) => {
      reads += 1;
      return await loadEditionEntries(options);
    },
  });
  const props = {
    db: publicDb,
    now: FRESH_NOW,
    practiceJurisdictions: [],
    subject: {
      type: "person",
      name: "Ivan Sidorov",
      birthDate: { year: 1960, month: 5, day: 12 },
      nationalityCodes: ["RU"],
    },
  } as const;
  try {
    const cold = (await publicScreen(props)).unwrap();
    expect(cold.status).toBe("unavailable");
    // Each list names the edition it is loading; none was screened.
    expect(
      cold.lists.map(({ source, status, reason, editionId }) => ({
        source,
        status,
        reason,
        editionId,
      })),
    ).toEqual(
      cold.lists.map(({ source }) => ({
        source,
        status: "unavailable",
        reason: "warming",
        editionId: activeEdition(source),
      })),
    );
    await publicScreen.warmupSettled();
    expect(reads).toBe(sanctionsSourceIds().length);
    const backgroundMessages = [...messages];
    const matched = (await publicScreen(props)).unwrap();
    expect(matched.status).toBe("possible-match");
    expect(
      matched.lists.find(({ source }) => source === "eu")?.possibleMatches.at(0)
        ?.sourceEntryId,
    ).toBe("person");
    expect(matched.lists.find(({ source }) => source === "eu")?.editionId).toBe(
      activeEdition("eu"),
    );
    expect(reads).toBe(sanctionsSourceIds().length);
    return { messages: backgroundMessages, matched };
  } finally {
    await pool.close();
  }
};

describe("public sanctions search parity", () => {
  test(
    "a public reader grant failure does not poison signed-in screening",
    async () => {
      const context = new InMemoryRateLimitContext();
      const route = createPublicSanctionsRoute({
        db: publicDb,
        now: FRESH_NOW,
        rateLimitOptions: {
          context,
          generator: scopedGenerator("failure-isolation-test"),
          duration: 60_000,
          max: 1000,
        },
      });
      await db.execute(sql`REVOKE SELECT (content_hash, payload)
        ON sanctions_entry_payloads FROM stella_public_sanctions_reader`);
      try {
        const response = await route.handle(
          new Request("http://localhost/sanctions/search", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              subject: { type: "organization", name: clearSubject.name },
            }),
          }),
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          status: "unavailable",
          lists: sanctionsSourceIds().map((source) => ({
            source,
            status: "unavailable",
            reason: "load-failed",
          })),
        });
        const inProduct = (
          await screenSanctionsSubject({
            db: requestDb,
            subject: {
              type: "organization",
              name: clearSubject.name,
              identifiers: [],
            },
            practiceJurisdictions: [],
            now: FRESH_NOW,
          })
        ).unwrap();
        expect(inProduct.status).toBe("clear");
        expect(inProduct.lists.every(({ status }) => status === "clear")).toBe(
          true,
        );
      } finally {
        await db.execute(sql`GRANT SELECT (content_hash, payload)
          ON sanctions_entry_payloads TO stella_public_sanctions_reader`);
        context.kill();
      }
    },
    DB_TEST_TIMEOUT_MS,
  );

  test(
    "public success outcomes contain only the public response contract",
    async () => {
      expect((await assertParity({ subject: clearSubject })).status).toBe(
        "clear",
      );
      const matched = await assertParity({
        subject: {
          type: "person",
          firstName: "Ivan",
          lastName: "Sidorov",
          dateOfBirth: null,
          nationalityCodes: [],
        },
      });
      expect(matched.status).toBe("possible-match");
      expect(
        matched.lists
          .find(({ source }) => source === "eu")
          ?.possibleMatches.at(0)?.name,
      ).toBe("Ivan Petrovich Sidorov");
    },
    DB_TEST_TIMEOUT_MS,
  );

  test(
    "public worker never reports a listed diacritic person clear",
    async () => {
      const result = await assertParity({
        subject: {
          type: "person",
          firstName: "Čeněk",
          lastName: "Říha",
          dateOfBirth: null,
          nationalityCodes: [],
        },
      });
      expect(result.status).toBe("possible-match");
      expect(
        result.lists
          .find(({ source }) => source === "eu")
          ?.possibleMatches.at(0)?.sourceEntryId,
      ).toBe("czech-person");
    },
    DB_TEST_TIMEOUT_MS,
  );

  test(
    "runs under a read-only role with no privileges outside the sanctions corpus",
    async () => {
      const corpusTables = [
        sanctionsSources,
        sanctionsEditions,
        sanctionsEntryPayloads,
        sanctionsEditionEntries,
      ].map(getTableName);
      const permissions = await publicDb(
        async (tx) =>
          await asTestRaw<Pick<typeof db, "execute">>(tx).execute(sql`
      WITH corpus(relation) AS (
        VALUES ${sql.join(
          corpusTables.map((table) => sql`(${table}::text)`),
          sql.raw(","),
        )}
      )
      SELECT current_user AS role,
        current_setting('transaction_read_only') AS read_only,
        has_column_privilege(current_user, 'sanctions_sources', 'marker_url', 'SELECT') AS config_read,
        EXISTS (
          SELECT 1 FROM pg_attribute AS columns
          INNER JOIN pg_class AS tables ON tables.oid = columns.attrelid
          INNER JOIN pg_namespace AS schemas ON schemas.oid = tables.relnamespace
          LEFT JOIN corpus ON schemas.nspname = 'public' AND corpus.relation = tables.relname
          WHERE schemas.nspname <> 'information_schema' AND schemas.nspname !~ '^pg_'
            AND tables.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND columns.attnum > 0 AND NOT columns.attisdropped
            AND corpus.relation IS NULL
            AND has_column_privilege(current_user, columns.attrelid, columns.attnum, 'SELECT')
        ) AS other_read,
        EXISTS (
          SELECT 1 FROM pg_class AS tables
          INNER JOIN pg_namespace AS schemas ON schemas.oid = tables.relnamespace
          WHERE schemas.nspname <> 'information_schema' AND schemas.nspname !~ '^pg_'
            AND tables.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND (has_table_privilege(current_user, tables.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
              OR EXISTS (
                SELECT 1 FROM pg_attribute AS columns
                WHERE columns.attrelid = tables.oid AND columns.attnum > 0 AND NOT columns.attisdropped
                  AND has_column_privilege(current_user, columns.attrelid, columns.attnum, 'INSERT,UPDATE,REFERENCES')
              ))
        ) AS can_write,
        EXISTS (
          SELECT 1 FROM pg_class AS sequences
          INNER JOIN pg_namespace AS schemas ON schemas.oid = sequences.relnamespace
          WHERE schemas.nspname <> 'information_schema' AND schemas.nspname !~ '^pg_'
            AND sequences.relkind = 'S'
            AND has_sequence_privilege(current_user, sequences.oid, 'USAGE,SELECT,UPDATE')
        ) AS can_use_sequence,
        has_database_privilege(current_user, current_database(), 'CREATE') OR EXISTS (
          SELECT 1 FROM pg_namespace AS schemas
          WHERE schemas.nspname <> 'information_schema' AND schemas.nspname !~ '^pg_'
            AND has_schema_privilege(current_user, schemas.oid, 'CREATE')
        ) AS can_create,
        EXISTS (
          SELECT 1 FROM pg_roles AS roles WHERE roles.rolname <> current_user
            AND (pg_has_role(current_user, roles.oid, 'SET')
              OR pg_has_role(current_user, roles.oid, 'USAGE')
              OR pg_has_role(current_user, roles.oid, 'MEMBER'))
        ) AS other_role,
        (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls
          FROM pg_roles WHERE rolname = current_user) AS privileged_attributes
    `),
      );
      expect(permissions.rows.at(0)).toMatchObject({
        role: "stella_public_sanctions_reader",
        read_only: "on",
        other_read: false,
        config_read: false,
        can_write: false,
        can_use_sequence: false,
        can_create: false,
        other_role: false,
        privileged_attributes: false,
      });
    },
    DB_TEST_TIMEOUT_MS,
  );

  test(
    "answers clear with identical editions and freshness on every list",
    async () => {
      const checked = await assertParity({ subject: clearSubject });
      expect(checked.status).toBe("clear");
      for (const list of checked.lists) {
        expect(list).toMatchObject({
          status: "clear",
          reason: null,
          editionId: activeEdition(list.source),
          totalMatches: 0,
          possibleMatches: [],
        });
      }
    },
    DB_TEST_TIMEOUT_MS,
  );

  test(
    "preserves conflicting partial birth-date and nationality evidence",
    async () => {
      const checked = await assertParity({
        subject: {
          type: "person",
          firstName: "Ivan Petrovich",
          lastName: "Sidorov",
          dateOfBirth: { precision: "year", year: 1971 },
          nationalityCodes: ["RU"],
        },
      });
      expect(checked.lists.find(({ source }) => source === "eu")).toMatchObject(
        {
          status: "possible-match",
          totalMatches: 1,
          possibleMatches: [
            expect.objectContaining({
              sourceEntryId: "person",
              evidence: expect.objectContaining({
                birthDate: "mismatch",
                nationality: "match",
                conflicts: ["birth-date"],
              }),
            }),
          ],
        },
      );
    },
    DB_TEST_TIMEOUT_MS,
  );

  test(
    "preserves the complete match count and truncated evidence",
    async () => {
      const checked = await assertParity({
        subject: {
          type: "organization",
          name: "Acme Trading Company",
          companyId: "01234567",
        },
      });
      const un = checked.lists.find(({ source }) => source === "un");
      expect(un).toMatchObject({
        status: "possible-match",
        totalMatches: MANY_MATCHES,
        truncated: true,
      });
      expect(un?.possibleMatches).toHaveLength(SANCTIONS_MATCH_LIMIT);
    },
    DB_TEST_TIMEOUT_MS,
  );

  test(
    "preserves stale-list unavailability and the Czech list's longer freshness window",
    async () => {
      const checked = await assertParity({
        subject: clearSubject,
        now: STALE_NOW,
      });
      expect(checked.status).toBe("unavailable");
      expect(checked.lists.find(({ source }) => source === "eu")).toMatchObject(
        {
          status: "unavailable",
          reason: "stale",
          totalMatches: 0,
          possibleMatches: [],
        },
      );
      expect(checked.lists.find(({ source }) => source === "cz")?.status).toBe(
        "clear",
      );
    },
    DB_TEST_TIMEOUT_MS,
  );

  test(
    "preserves missing editions and held updates without screening the held edition",
    async () => {
      const heldId = toSafeId<"sanctionsEdition">(Bun.randomUUIDv7());
      await db.insert(sanctionsEditions).values({
        id: heldId,
        sourceId: "ch",
        markerKey: hash("ch:held"),
        publishedAt: "2026-09-20",
        fileId: null,
        contentHash: hash("ch:held-content"),
        entryCount: 0,
        state: "staging",
      });
      await db
        .update(sanctionsSources)
        .set({ activeEditionId: null })
        .where(eq(sanctionsSources.id, "uk"));
      await db
        .update(sanctionsSources)
        .set({
          heldEditionId: heldId,
          heldGuardCode: "contracted",
          heldAt: VERIFIED_AT,
          heldPreviousCount: 1,
          heldNextCount: 0,
        })
        .where(eq(sanctionsSources.id, "ch"));
      try {
        const checked = await assertParity({ subject: clearSubject });
        expect(checked.status).toBe("unavailable");
        expect(
          checked.lists.find(({ source }) => source === "uk"),
        ).toMatchObject({
          status: "unavailable",
          reason: "not-loaded",
          editionId: null,
        });
        expect(
          checked.lists.find(({ source }) => source === "ch"),
        ).toMatchObject({
          status: "clear",
          editionId: activeEdition("ch"),
          pendingUpdate: {
            code: "contracted",
            heldAt: VERIFIED_AT.toISOString(),
            previousCount: 1,
            nextCount: 0,
          },
        });
      } finally {
        await db
          .update(sanctionsSources)
          .set({ activeEditionId: activeEdition("uk") })
          .where(eq(sanctionsSources.id, "uk"));
        await db
          .update(sanctionsSources)
          .set({
            heldEditionId: null,
            heldGuardCode: null,
            heldAt: null,
            heldPreviousCount: null,
            heldNextCount: null,
          })
          .where(eq(sanctionsSources.id, "ch"));
        await db
          .delete(sanctionsEditions)
          .where(eq(sanctionsEditions.id, heldId));
      }
    },
    DB_TEST_TIMEOUT_MS,
  );

  test.each([
    { engine: "index", entryCount: entriesFor("eu").length },
    { engine: "index", entryCount: entriesFor("eu").length + 1 },
    { engine: "worker", entryCount: entriesFor("eu").length },
    { engine: "worker", entryCount: entriesFor("eu").length + 1 },
  ] as const)(
    "public search reloads a newly activated edition without a refresh notification ($engine, $entryCount entries)",
    async ({ engine, entryCount }) => {
      let loads = 0;
      const cache = createSanctionsIndexCache({
        build: (lists) => {
          loads += 1;
          return buildScreeningIndex(lists);
        },
      });
      const pool = benchmarkPool();
      const publicScreen = createPublicSanctionsScreening({
        pool,
        loadEntries: async (props) => {
          loads += 1;
          return await loadEditionEntries(props);
        },
      });
      const screen =
        engine === "index"
          ? async (props: Parameters<typeof screenSanctionsSubject>[0]) =>
              await screenSanctionsSubject({ ...props, indexCache: cache })
          : publicScreen;
      const context = new InMemoryRateLimitContext();
      const route = createPublicSanctionsRoute({
        db: publicDb,
        now: FRESH_NOW,
        screen,
        rateLimitOptions: {
          context,
          generator: scopedGenerator("rollover-test"),
          max: 1000,
          duration: 60_000,
        },
      });
      const search = async (firstName: string, lastName: string) => {
        const response = await route.handle(
          new Request("http://localhost/sanctions/search", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              subject: { type: "person", firstName, lastName },
            }),
          }),
        );
        expect(response.status).toBe(200);
        const body = Value.Decode(
          publicSanctionsResponseSchema[200],
          await response.json(),
        );
        expect([
          ...Value.Errors(publicSanctionsResponseSchema[200], body),
        ]).toEqual([]);
        return body;
      };
      const id = toSafeId<"sanctionsEdition">(Bun.randomUUIDv7());
      const entries = Array.from({ length: entryCount }, (_, index) =>
        entry({
          source: "eu",
          sourceId: `rollover-${id}-${index}`,
          overrides:
            index === 0
              ? {
                  entityType: "person",
                  names: [{ name: "Zbigniew Wroblewski", quality: "strong" }],
                }
              : {},
        }),
      );
      // The worker answers "warming" until its background load of a new edition settles.
      const awaitWarmup = async () => {
        if (engine === "index") {
          return;
        }
        const warming = await search("Ivan", "Sidorov");
        expect(warming.status).toBe("unavailable");
        expect(warming.retryAfterSeconds).toBe(
          SANCTIONS_WARMING_RETRY_AFTER_SECONDS,
        );
        await publicScreen.warmupSettled();
      };
      try {
        await awaitWarmup();
        const initial = await search("Ivan", "Sidorov");
        expect(initial.retryAfterSeconds).toBeNull();
        expect(initial.status).toBe("possible-match");
        expect(
          (
            initial.lists.find((list) => list.source === "eu") ??
            panic("Missing EU list")
          ).editionId,
        ).toBe(activeEdition("eu"));
        const warmed = loads;
        expect(warmed).toBe(sanctionsSourceIds().length);
        await search("Ivan", "Sidorov");
        expect(loads).toBe(warmed);
        await db.insert(sanctionsEditions).values({
          id,
          sourceId: "eu",
          markerKey: hash(id),
          publishedAt: "2026-09-20",
          contentHash: hash(`${id}:content`),
          entryCount,
          state: "ready",
          activatedAt: VERIFIED_AT,
        });
        await db.insert(sanctionsEntryPayloads).values(
          entries.map((payload) => ({
            contentHash: hash(JSON.stringify(payload)),
            payload,
          })),
        );
        await db.insert(sanctionsEditionEntries).values(
          entries.map((payload) => ({
            editionId: id,
            sourceEntryId: payload.sourceId,
            contentHash: hash(JSON.stringify(payload)),
          })),
        );
        await db
          .update(sanctionsSources)
          .set({ activeEditionId: id })
          .where(eq(sanctionsSources.id, "eu"));
        // The same mounted route and cache receive no refresh call or notification.
        await awaitWarmup();
        const oldPerson = await search("Ivan", "Sidorov");
        expect(oldPerson.status).toBe("clear");
        expect(
          (
            oldPerson.lists.find((list) => list.source === "eu") ??
            panic("Missing EU list")
          ).editionId,
        ).toBe(id);
        expect(loads).toBe(warmed + 1);
        const newPerson = await search("Zbigniew", "Wroblewski");
        expect(newPerson.status).toBe("possible-match");
        const eu =
          newPerson.lists.find((list) => list.source === "eu") ??
          panic("Missing EU list");
        expect(eu.editionId).toBe(id);
        const firstMatch =
          eu.possibleMatches.at(0) ?? panic("Missing rollover match");
        const firstEntry = entries.at(0) ?? panic("Missing rollover entry");
        expect(firstMatch.sourceEntryId).toBe(firstEntry.sourceId);
        await search("Ivan", "Sidorov");
        await search("Zbigniew", "Wroblewski");
        expect(loads).toBe(warmed + 1);
      } finally {
        await db
          .update(sanctionsSources)
          .set({ activeEditionId: activeEdition("eu") })
          .where(eq(sanctionsSources.id, "eu"));
        await db
          .delete(sanctionsEditionEntries)
          .where(eq(sanctionsEditionEntries.editionId, id));
        for (const payload of entries) {
          await db
            .delete(sanctionsEntryPayloads)
            .where(
              eq(
                sanctionsEntryPayloads.contentHash,
                hash(JSON.stringify(payload)),
              ),
            );
        }
        await db.delete(sanctionsEditions).where(eq(sanctionsEditions.id, id));
        context.kill();
        await pool.close();
        pools.delete(pool);
      }
    },
    DB_TEST_TIMEOUT_MS,
  );

  test.each([1, 2] as const)(
    "a cold search answers warming and one background warmup readies every list (size %s)",
    async (size) => {
      await exerciseColdWarmup(size);
    },
    DB_TEST_TIMEOUT_MS,
  );

  test.each([1, 2] as const)(
    "the background warmup sends the matcher list entries only, never the query (size %s)",
    async (size) => {
      const { messages, matched } = await exerciseColdWarmup(size);
      expect(messages.length).toBeGreaterThan(0);
      expect(
        messages.filter(({ type }) => type !== "entries" && type !== "index"),
      ).toEqual([]);
      expect(
        messages
          .filter((message) => message.type === "index")
          .map(({ source }) => source)
          .toSorted(),
      ).toEqual(sanctionsSourceIds().toSorted());
      expect(
        matched.lists
          .find(({ source }) => source === "eu")
          ?.possibleMatches.at(0)?.evidence,
      ).toMatchObject({ birthDate: "match", nationality: "match" });
    },
    DB_TEST_TIMEOUT_MS,
  );

  test(
    "measures cold and warm public searches over 20000 stored entries",
    async () => {
      for (
        let offset = 0;
        offset < BENCHMARK_ENTRY_COUNT;
        offset += INSERT_BATCH_SIZE
      ) {
        await seedEntries(
          "eu",
          Array.from(
            {
              length: Math.min(
                INSERT_BATCH_SIZE,
                BENCHMARK_ENTRY_COUNT - offset,
              ),
            },
            (_, index) => {
              const entryIndex = offset + index;
              return entry({
                source: "eu",
                sourceId: `benchmark-${entryIndex}`,
                overrides: {
                  names: [
                    {
                      name: `Registered Entity ${entryIndex} Holdings`,
                      quality: "strong",
                    },
                  ],
                },
              });
            },
          ),
        );
      }
      // Finish the immutable edition before loading either access boundary's index.
      // Valid single-token input can still exceed the edit-distance backstop.
      const costlyName = "abcde".repeat(90);
      const costly = Array.from({ length: 8 }, (_, index) =>
        entry({
          source: "eu",
          sourceId: `costly-${index}`,
          overrides: {
            names: [{ name: `${costlyName}${index}`, quality: "strong" }],
          },
        }),
      );
      const partialAliases = Array.from({ length: 100 }, (_, index) =>
        entry({
          source: "eu",
          sourceId: `partial-${index}`,
          overrides: {
            entityType: "person",
            names: [{ name: `Mohammed${index} Ali`, quality: "weak" }],
          },
        }),
      );
      await seedEntries("eu", [...costly, ...partialAliases]);
      await db
        .update(sanctionsEditions)
        .set({
          entryCount:
            entriesFor("eu").length +
            BENCHMARK_ENTRY_COUNT +
            costly.length +
            partialAliases.length,
        })
        .where(eq(sanctionsEditions.id, activeEdition("eu")));
      const inputDigests = new Map<SanctionsSource, string>();
      const digest = (lists: Parameters<typeof buildScreeningIndex>[0]) => {
        const inputHash = createHash("sha256");
        for (const input of lists) {
          inputHash.update(
            JSON.stringify({
              version: input.version,
              entryCount: input.entries.length,
            }),
          );
          for (const payload of input.entries) {
            inputHash.update(JSON.stringify(payload));
          }
        }
        return inputHash.digest("hex");
      };
      const recorded = recordingMatcherWorker();
      const pool = createSanctionsMatcherPool({
        deadlineMs: 10_000,
        createWorker: recorded.createWorker,
      });
      pools.add(pool);
      const context = new InMemoryRateLimitContext();
      const publicScreen = createPublicSanctionsScreening({
        pool,
        loadEntries: async (props) => {
          const entries = await loadEditionEntries(props);
          const source =
            entries.at(0)?.source ?? panic("Missing benchmark entry");
          inputDigests.set(
            source,
            digest([
              {
                version: {
                  source,
                  publishedAt: props.edition.publishedAt,
                  fileId: props.edition.fileId,
                },
                entries,
              },
            ]),
          );
          return entries;
        },
      });
      const route = createPublicSanctionsRoute({
        db: publicDb,
        now: FRESH_NOW,
        screen: publicScreen,
        rateLimitOptions: {
          context,
          generator: scopedGenerator("timing-test"),
          duration: 60_000,
          max: 1000,
        },
      });
      const run = async () =>
        await route.handle(
          new Request("http://localhost/sanctions/search", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              subject: { type: "organization", name: clearSubject.name },
            }),
          }),
        );
      try {
        const coldStart = performance.now();
        const cold = await run();
        const coldBody = await cold.json();
        const coldMs = performance.now() - coldStart;
        await publicScreen.warmupSettled();
        const warmupMs = performance.now() - coldStart;
        const warmStart = performance.now();
        const warm = await run();
        const warmBody = await warm.json();
        const warmMs = performance.now() - warmStart;
        expect(cold.status).toBe(200);
        expect(warm.status).toBe(200);
        expect(coldBody).toMatchObject({
          status: "unavailable",
          retryAfterSeconds: SANCTIONS_WARMING_RETRY_AFTER_SECONDS,
        });
        expect(warmBody).toMatchObject({
          status: "clear",
          retryAfterSeconds: null,
          lists: expect.any(Array),
        });
        console.info(
          JSON.stringify({
            entries: BENCHMARK_ENTRY_COUNT,
            coldMs: Number(coldMs.toFixed(2)),
            warmupMs: Number(warmupMs.toFixed(2)),
            warmMs: Number(warmMs.toFixed(2)),
          }),
        );
        for (const name of [
          "Registered Entity Holdings",
          "Registered a b c d e f g h i j k l m n o p q r s t u v z",
        ]) {
          const adversarialRequest = () =>
            new Request("http://localhost/sanctions/search", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ subject: { type: "organization", name } }),
            });
          expect((await route.handle(adversarialRequest())).status).toBe(200);
          const before = { ...recorded.work };
          const began = performance.now();
          let lastTick = began;
          let maximumTurnMs = 0;
          let ticks = 0;
          const heartbeat = setInterval(() => {
            const current = performance.now();
            maximumTurnMs = Math.max(maximumTurnMs, current - lastTick);
            lastTick = current;
            ticks += 1;
          }, 1);
          try {
            const response = await route.handle(adversarialRequest());
            expect(response.status).toBe(200);
            maximumTurnMs = Math.max(
              maximumTurnMs,
              performance.now() - lastTick,
            );
            // A warm search evaluates each source once and reloads no entries.
            expect(recorded.work.screenings - before.screenings).toBe(
              Object.keys(SANCTIONS_SOURCES).length,
            );
            expect(recorded.work.entries - before.entries).toBe(0);
            expect(recorded.work.entryBatches - before.entryBatches).toBe(0);
            console.info(
              JSON.stringify({
                adversarialService: name,
                totalMs: Number((performance.now() - began).toFixed(2)),
                maximumTurnMs: Number(maximumTurnMs.toFixed(2)),
                ticks,
              }),
            );
          } finally {
            clearInterval(heartbeat);
          }
        }
        const subjects = [
          ...[
            "Registered Entity 42 Holdings",
            "General Trading LLC",
            "International Petroleum Shipping",
          ].map(
            (name) =>
              ({ type: "organization", name, companyId: null }) as const,
          ),
          {
            type: "person",
            firstName: "Ivan",
            lastName: "Sidorov",
            dateOfBirth: null,
            nationalityCodes: [],
          },
          { type: "organization", name: costlyName, companyId: null },
          { type: "organization", name: "Mohammed Ali", companyId: null },
        ] as const satisfies readonly NameSubject[];
        const publicResponses = new Map<string, Response>();
        const analytics = installRecordingAnalytics();
        const logger = installRecordingLogger();
        try {
          for (const subject of subjects) {
            const response = await route.handle(
              new Request("http://localhost/sanctions/search", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ subject: publicWireSubject(subject) }),
              }),
            );
            publicResponses.set(JSON.stringify(subject), response);
          }
          for (const identity of [clearSubject.name, "Ivan Sidorov"]) {
            expect(JSON.stringify(analytics.events)).not.toContain(identity);
            expect(JSON.stringify(logger.records)).not.toContain(identity);
          }
        } finally {
          analytics.restore();
          logger.restore();
        }
        // The worker phase reads and compiles the full corpus. Retire it before
        // the product phase compiles the independently loaded, digest-checked rows.
        await pool.close();
        pools.delete(pool);
        const parityCaches = {
          product: createSanctionsIndexCache({
            build: (lists) => {
              const list = lists.at(0) ?? panic("Missing benchmark list");
              expect(digest(lists)).toBe(
                inputDigests.get(list.version.source) ??
                  panic("Missing benchmark input digest"),
              );
              return buildScreeningIndex(lists);
            },
          }),
          public: pool,
        };
        const parity = async (subject: NameSubject) => {
          const publicResponse =
            publicResponses.get(JSON.stringify(subject)) ??
            panic("Missing measured worker response");
          return await assertParity({
            subject,
            caches: parityCaches,
            publicResponse,
          });
        };
        for (const name of [
          "Registered Entity 42 Holdings",
          "General Trading LLC",
          "International Petroleum Shipping",
        ]) {
          const normal = await parity({
            type: "organization",
            name,
            companyId: null,
          });
          expect(
            normal.lists.every((list) => list.status !== "unavailable"),
          ).toBe(true);
        }
        const person = await parity({
          type: "person",
          firstName: "Ivan",
          lastName: "Sidorov",
          dateOfBirth: null,
          nationalityCodes: [],
        });
        expect(person.status).toBe("possible-match");
        const incomplete = await parity({
          type: "organization",
          name: costlyName,
          companyId: null,
        });
        expect(
          incomplete.lists.find(({ source }) => source === "eu"),
        ).toMatchObject({
          status: "unavailable",
          reason: "load-failed",
          totalMatches: 0,
          possibleMatches: [],
        });
        expect(incomplete.status).not.toBe("clear");
        const partial = await parity({
          type: "organization",
          name: "Mohammed Ali",
          companyId: null,
        });
        expect(
          partial.lists.find(({ source }) => source === "eu"),
        ).toMatchObject({
          status: "unavailable",
          reason: "load-failed",
          possibleMatches: [],
        });
        expect(partial.status).not.toBe("clear");
      } finally {
        context.kill();
        await pool.close();
        pools.delete(pool);
      }
    },
    DB_TEST_TIMEOUT_MS,
  );
});
