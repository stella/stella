import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, getTableName, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { createHash } from "node:crypto";

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
import { toSafeId } from "@/api/lib/branded-types";
import { runEntityCheckShared } from "@/api/lib/business-registries/entity-checks";
import type { CounterpartyCheckSubject } from "@/api/lib/business-registries/entity-checks";
import { createSanctionsPublicReadDb } from "@/api/lib/lists/sanctions/read-db";
import type { SanctionsPublicReadDb } from "@/api/lib/lists/sanctions/read-db";
import { createSanctionsIndexCache } from "@/api/lib/lists/sanctions/screening-index";
import {
  SANCTIONS_MATCH_LIMIT,
  screenSanctionsSubject,
} from "@/api/lib/lists/sanctions/screening-service";
import {
  SANCTIONS_SOURCE_CONFIG,
  sanctionsSourceIds,
} from "@/api/lib/lists/sanctions/source-config";
import {
  InMemoryRateLimitContext,
  scopedGenerator,
} from "@/api/lib/rate-limit/rate-limit";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const DB_TEST_TIMEOUT_MS = 120_000;
const VERIFIED_AT = new Date("2026-09-20T08:00:00Z");
const FRESH_NOW = new Date("2026-09-20T09:00:00Z");
const STALE_NOW = new Date("2026-09-23T08:00:00Z");
const MANY_MATCHES = SANCTIONS_MATCH_LIMIT + 5;
const BENCHMARK_ENTRY_COUNT = 20_000;
const INSERT_BATCH_SIZE = 100;

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
  for (let offset = 0; offset < entries.length; offset += INSERT_BATCH_SIZE) {
    const batch = entries.slice(offset, offset + INSERT_BATCH_SIZE);
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

afterAll(async () => await client.close());

type NameSubject = Extract<
  CounterpartyCheckSubject,
  { type: "person" | "organization" }
>;
type ParityOptions = {
  subject: NameSubject;
  now?: Date;
  caches?: {
    product: ReturnType<typeof createSanctionsIndexCache>;
    public: ReturnType<typeof createSanctionsIndexCache>;
  };
};

const assertParity = async ({
  subject,
  now = FRESH_NOW,
  caches,
}: ParityOptions) => {
  // Separate caches ensure both access boundaries load the corpus themselves.
  const productCache = caches?.product ?? createSanctionsIndexCache();
  const publicCache = caches?.public ?? createSanctionsIndexCache();
  const inProduct = (
    await runEntityCheckShared({
      observer: "unobserved",
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
  const context = new InMemoryRateLimitContext();
  const route = createPublicSanctionsRoute({
    db: publicDb,
    now,
    indexCache: publicCache,
    rateLimitOptions: {
      context,
      generator: scopedGenerator("parity-test"),
      duration: 60_000,
      max: 1000,
    },
  });
  const wireSubject =
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
  try {
    const response = await route.handle(
      new Request("http://localhost/sanctions/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subject: wireSubject }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ...screening,
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
  }
};

const clearSubject = {
  type: "organization",
  name: "Blue Meadow Bakery",
  companyId: null,
} as const satisfies NameSubject;

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
      const compiled = new Map<
        SanctionsSource,
        {
          inputDigest: string;
          index: ReturnType<typeof buildScreeningIndex>;
        }
      >();
      // Each role still loads its own rows. Share only pure compilation, after
      // proving the entire reader input equals the first role's input.
      const build = (lists: Parameters<typeof buildScreeningIndex>[0]) => {
        const list = lists.at(0) ?? panic("Missing benchmark list");
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
        const inputDigest = inputHash.digest("hex");
        const known = compiled.get(list.version.source);
        if (known !== undefined) {
          expect(inputDigest).toBe(known.inputDigest);
          return known.index;
        }
        const index = buildScreeningIndex(lists);
        compiled.set(list.version.source, { inputDigest, index });
        return index;
      };
      const cache = createSanctionsIndexCache({ build });
      const context = new InMemoryRateLimitContext();
      const route = createPublicSanctionsRoute({
        db: publicDb,
        now: FRESH_NOW,
        indexCache: cache,
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
        const warmStart = performance.now();
        const warm = await run();
        const warmBody = await warm.json();
        const warmMs = performance.now() - warmStart;
        expect(cold.status).toBe(200);
        expect(warm.status).toBe(200);
        expect(warmBody).toEqual(coldBody);
        expect(coldBody).toMatchObject({
          status: "clear",
          lists: expect.any(Array),
        });
        console.info(
          JSON.stringify({
            entries: BENCHMARK_ENTRY_COUNT,
            coldMs: Number(coldMs.toFixed(2)),
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
            expect(ticks).toBeGreaterThan(0);
            maximumTurnMs = Math.max(
              maximumTurnMs,
              performance.now() - lastTick,
            );
            console.info(
              JSON.stringify({
                adversarialService: name,
                totalMs: Number((performance.now() - began).toFixed(2)),
                maximumTurnMs: Number(maximumTurnMs.toFixed(2)),
              }),
            );
          } finally {
            clearInterval(heartbeat);
          }
        }
        const parityCaches = {
          product: createSanctionsIndexCache({ build }),
          public: cache,
        };
        for (const name of [
          "Registered Entity 42 Holdings",
          "General Trading LLC",
          "International Petroleum Shipping",
        ]) {
          const normal = await assertParity({
            subject: { type: "organization", name, companyId: null },
            caches: parityCaches,
          });
          expect(
            normal.lists.every((list) => list.status !== "unavailable"),
          ).toBe(true);
        }
        const person = await assertParity({
          caches: parityCaches,
          subject: {
            type: "person",
            firstName: "Ivan",
            lastName: "Sidorov",
            dateOfBirth: null,
            nationalityCodes: [],
          },
        });
        expect(person.status).toBe("possible-match");
        const incomplete = await assertParity({
          caches: parityCaches,
          subject: { type: "organization", name: costlyName, companyId: null },
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
        const partial = await assertParity({
          caches: parityCaches,
          subject: {
            type: "organization",
            name: "Mohammed Ali",
            companyId: null,
          },
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
      }
    },
    DB_TEST_TIMEOUT_MS,
  );
});
