import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import fc from "fast-check";

import type { fetchWithTimeout } from "@stll/fetch";
import { assertProperty } from "@stll/property-testing";

import {
  stellaCaseLawReader,
  stellaPublicLawReader,
  stellaCaseLawAnalysisReader,
  stellaCorpusSampleReader,
  stellaIngestion,
} from "@/api/db/rls";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  softLawSources,
  softLawIngestionAttempts,
  softLawDocuments,
  softLawDocumentVersions,
  softLawDocumentLocators,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { rawSourcePayloadKey } from "@/api/lib/legal-search/raw-source-storage";
import type { WriteRawSourcePayload } from "@/api/lib/legal-search/raw-source-storage";
import { createSoftLawIngestionStore } from "@/api/lib/legal-search/soft-law-ingestion-store";
import type {
  SoftLawSourceAdapter,
  SoftLawEntry,
  SoftLawDocumentInput,
} from "@/api/lib/legal-search/soft-law-types";
import { SoftLawIngestionError } from "@/api/lib/legal-search/soft-law-types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";

import { runSoftLawIngestion } from "./ingestion";
import { SoftLawAccessError } from "./publisher-access";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const permissionDenied = (error: unknown) => {
  let cause = error;
  for (let depth = 0; depth < 8; depth++) {
    if (typeof cause !== "object" || cause === null) {
      return false;
    }
    if ("code" in cause && cause.code === "42501") {
      return true;
    }
    if (cause instanceof Error && cause.message.includes("permission denied")) {
      return true;
    }
    if (!("cause" in cause)) {
      return false;
    }
    cause = cause.cause;
  }
  return false;
};
const entry = (
  url = "https://uoou.gov.cz/a",
  title = "Doporučení",
  reference = "02/2024",
): SoftLawEntry => ({
  url,
  metadata: {
    title,
    kind: "recommendation",
    statedReference: { state: "stated", value: reference },
    issuedOn: { state: "not_stated" },
    validity: { state: "not_stated", basis: "source_stated" },
  },
  sourceDates: {},
});
const document = (
  item: SoftLawEntry,
  content = "original",
): SoftLawDocumentInput => ({
  metadata: item.metadata,
  raw: [
    {
      role: "document",
      bytes: new TextEncoder().encode(content),
      contentType: "text/html",
    },
  ],
  text: content,
  extractionQuality: "html",
  sourceDates: item.sourceDates,
});
const adapter = (entries: readonly SoftLawEntry[], content = "original") =>
  ({
    key: "soft-law-test",
    authority: "cz-uoou",
    access: {
      publisherGate: "uoou-cz",
      userAgent: "Stella/1.0 (+https://stella.example/contact)",
      window: { type: "any_time" },
    },
    discover: async () => ({ entries, nextCursor: null }),
    fetchDocument: async (item) => document(item, content),
    getTotalCount: async () => ({ type: "no-count-endpoint" }),
    sliceWalk: { type: "unsupported", reason: "Complete listing" },
    sourceFields: {
      status: "declared",
      fields: {},
      listSourceFields: () => [],
    },
    sourceSurfaces: { surfaces: {} },
  }) as const satisfies SoftLawSourceAdapter;

type TestRunOptions = {
  request?: typeof fetchWithTimeout;
  now?: () => Date;
  scopedDb?: ScopedDb;
  writeRaw?: WriteRawSourcePayload;
};
const withSource = async (
  url: string,
  fn: (options: {
    db: GatedTestDb;
    sourceId: SafeId<"softLawSource">;
    run: (
      sourceAdapter: SoftLawSourceAdapter,
      options?: TestRunOptions,
    ) => ReturnType<typeof runSoftLawIngestion>;
  }) => Promise<void>,
) =>
  await withGatedTestClients(url, async ({ openClient }) => {
    const { db } = openClient({ max: 3 });
    const sourceId = createSafeId<"softLawSource">();
    await db.insert(softLawSources).values({
      id: sourceId,
      adapterKey: `soft-law-test-${sourceId}`,
      descriptor: {
        license: "public-domain",
        attribution: null,
        allowsRedistribution: true,
        allowsDerivedAi: true,
      },
    });
    const run = async (
      sourceAdapter: SoftLawSourceAdapter,
      options: TestRunOptions = {},
    ) =>
      await runSoftLawIngestion({
        sourceId,
        adapter: { ...sourceAdapter, key: `soft-law-test-${sourceId}` },
        scopedDb:
          options.scopedDb ?? (async (work) => await db.transaction(work)),
        signal: new AbortController().signal,
        writeRaw:
          options.writeRaw ??
          (async (rawOptions) => rawSourcePayloadKey(rawOptions)),
        accessDependencies: {
          reserve: async () => {},
          ...(options.request ? { request: options.request } : {}),
          ...(options.now ? { now: options.now } : {}),
        },
      });
    try {
      await fn({ db, sourceId, run });
    } finally {
      await db
        .delete(softLawIngestionAttempts)
        .where(eq(softLawIngestionAttempts.sourceId, sourceId));
      await db.execute(
        sql`DELETE FROM soft_law_document_locators WHERE document_id IN (SELECT id FROM soft_law_documents WHERE source_id = ${sourceId})`,
      );
      await db.execute(
        sql`DELETE FROM soft_law_document_versions WHERE document_id IN (SELECT id FROM soft_law_documents WHERE source_id = ${sourceId})`,
      );
      await db
        .delete(softLawDocuments)
        .where(eq(softLawDocuments.sourceId, sourceId));
      await db.delete(softLawSources).where(eq(softLawSources.id, sourceId));
    }
  });

if (!databaseUrl || !enabled) {
  describe.skip("guidance ingestion on real Postgres", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS and DATABASE_URL", () => {});
  });
} else {
  describe("guidance ingestion on real Postgres", () => {
    test("a URL move preserves identity and raw versions; a changed hash creates history", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        const item = entry();
        expect(await run(adapter([item]))).toEqual({ status: "complete" });
        const before = await db
          .select()
          .from(softLawDocuments)
          .where(eq(softLawDocuments.sourceId, sourceId));
        const id = before.at(-1)?.id;
        expect(id).toBeDefined();
        expect(
          await run(adapter([entry("https://uoou.gov.cz/moved")])),
        ).toEqual({ status: "complete" });
        if (!id) {
          throw new SoftLawIngestionError({ message: "Missing test document" });
        }
        expect(
          await db
            .select()
            .from(softLawDocumentLocators)
            .where(eq(softLawDocumentLocators.documentId, id)),
        ).toHaveLength(2);
        const locators = await db
          .select()
          .from(softLawDocumentLocators)
          .where(eq(softLawDocumentLocators.documentId, id));
        expect(
          locators.find((locator) => locator.url === item.url)?.state,
        ).toBe("historical");
        expect(
          locators.find((locator) => locator.url.endsWith("/moved"))?.state,
        ).toBe("current");
        expect(
          await db
            .select()
            .from(softLawDocumentVersions)
            .where(eq(softLawDocumentVersions.documentId, id)),
        ).toHaveLength(1);
        expect(
          await run(adapter([entry("https://uoou.gov.cz/moved")], "changed")),
        ).toEqual({ status: "complete" });
        const versions = await db
          .select()
          .from(softLawDocumentVersions)
          .where(eq(softLawDocumentVersions.documentId, id))
          .orderBy(softLawDocumentVersions.sequence);
        expect(versions.map((v) => v.extractedText)).toEqual([
          "original",
          "changed",
        ]);
        expect(versions.at(0)?.observedTo).not.toBeNull();
        expect(versions.at(1)?.observedTo).toBeNull();
      }));

    test("a vanished entry is retained, and re-listing restores listed", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        const items = Array.from({ length: 5 }, (_, i) =>
          entry(`https://uoou.gov.cz/${i}`, `Guidance ${i}`, `${i}/2024`),
        );
        await run(adapter(items));
        const id = (
          await db
            .select()
            .from(softLawDocuments)
            .where(eq(softLawDocuments.sourceId, sourceId))
        ).find((doc) => doc.title === "Guidance 0")?.id;
        if (!id) {
          throw new SoftLawIngestionError({ message: "Missing test document" });
        }
        const before = (
          await db
            .select()
            .from(softLawDocuments)
            .where(eq(softLawDocuments.id, id))
        ).at(0);
        expect(await run(adapter(items.slice(1)))).toEqual({
          status: "complete",
        });
        const after = (
          await db
            .select()
            .from(softLawDocuments)
            .where(eq(softLawDocuments.id, id))
        ).at(0);
        expect(after?.listingState).toBe("no_longer_listed");
        expect(after?.lastSeenAt).toEqual(before?.lastSeenAt);
        expect(await run(adapter(items))).toEqual({ status: "complete" });
        expect(
          (
            await db
              .select()
              .from(softLawDocuments)
              .where(eq(softLawDocuments.id, id))
          ).at(0)?.listingState,
        ).toBe("listed");
      }));

    test("an interrupted multi-page run resumes its committed checkpoint", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        const first = entry(undefined, Bun.randomUUIDv7(), Bun.randomUUIDv7());
        const second = entry(
          "https://uoou.gov.cz/b",
          Bun.randomUUIDv7(),
          Bun.randomUUIDv7(),
        );
        let fail = true;
        const cursors: (string | null)[] = [];
        const pages = {
          ...adapter([]),
          discover: async ({
            cursor,
          }: Parameters<SoftLawSourceAdapter["discover"]>[0]) => {
            cursors.push(cursor);
            if (cursor === null) {
              return { entries: [first], nextCursor: "second" };
            }
            if (fail) {
              throw new SoftLawIngestionError({
                message: "Injected interruption",
              });
            }
            return { entries: [second], nextCursor: null };
          },
        };
        expect((await run(pages)).status).toBe("failed");
        fail = false;
        expect(await run(pages)).toEqual({ status: "complete" });
        expect(cursors).toEqual([null, "second", "second"]);
        const rows = await db
          .select()
          .from(softLawDocuments)
          .where(eq(softLawDocuments.sourceId, sourceId));
        expect(rows).toHaveLength(2);
        expect(rows.every((row) => row.listingState === "listed")).toBe(true);
      }));

    test("overlapping source runs grant only one writer", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        let entered!: () => void;
        const inside = new Promise<void>((resolve) => {
          entered = resolve;
        });
        let release!: () => void;
        const wait = new Promise<void>((resolve) => {
          release = resolve;
        });
        const item = entry(undefined, Bun.randomUUIDv7(), Bun.randomUUIDv7());
        const slow = {
          ...adapter([item]),
          discover: async () => {
            entered();
            await wait;
            return { entries: [item], nextCursor: null };
          },
        };
        const first = run(slow);
        await inside;
        try {
          expect(await run(adapter([item]))).toEqual({ status: "busy" });
        } finally {
          release();
        }
        expect(await first).toEqual({ status: "complete" });
        expect(
          await db
            .select()
            .from(softLawDocuments)
            .where(eq(softLawDocuments.sourceId, sourceId)),
        ).toHaveLength(1);
      }));

    test("a publisher block persists and prevents subsequent discovery", async () =>
      await withSource(databaseUrl, async ({ run }) => {
        let requests = 0;
        const blocked = {
          ...adapter([]),
          discover: async ({
            fetch,
          }: Parameters<SoftLawSourceAdapter["discover"]>[0]) => {
            requests++;
            await fetch("https://uoou.gov.cz/a");
            return { entries: [], nextCursor: null };
          },
        };
        expect(
          await run(blocked, {
            request: async () => new Response("blocked", { status: 403 }),
          }),
        ).toEqual({ status: "blocked", reason: "forbidden" });
        expect(await run(blocked)).toEqual({
          status: "blocked",
          reason: "forbidden",
        });
        expect(requests).toBe(1);
      }));

    test("a reused unnumbered locator is rejected instead of changing identity", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        const first = {
          ...entry(),
          metadata: {
            ...entry().metadata,
            statedReference: { state: "not_stated" as const },
          },
        };
        expect(await run(adapter([first]))).toEqual({ status: "complete" });
        const before = await db
          .select()
          .from(softLawDocuments)
          .where(eq(softLawDocuments.sourceId, sourceId));
        expect(
          await run(
            adapter(
              [
                {
                  ...first,
                  metadata: { ...first.metadata, title: "Renamed guidance" },
                },
              ],
              "updated",
            ),
          ),
        ).toEqual({ status: "complete" });
        const after = await db
          .select()
          .from(softLawDocuments)
          .where(eq(softLawDocuments.sourceId, sourceId));
        expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
        expect(after.at(0)?.title).toBe(first.metadata.title);
        expect(
          (
            await db
              .select()
              .from(softLawIngestionAttempts)
              .where(eq(softLawIngestionAttempts.sourceId, sourceId))
          ).some((attempt) => attempt.tag === "ambiguous_locator"),
        ).toBe(true);
      }));

    test("a reused locator cannot replace a different numbered document", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        expect(await run(adapter([entry()]))).toEqual({ status: "complete" });
        const before = await db
          .select()
          .from(softLawDocuments)
          .where(eq(softLawDocuments.sourceId, sourceId));
        expect(
          (
            await run(
              adapter([entry(undefined, "Other document", "03/2024")], "other"),
            )
          ).status,
        ).toBe("complete");
        const after = await db
          .select()
          .from(softLawDocuments)
          .where(eq(softLawDocuments.sourceId, sourceId));
        expect(after.map((row) => row.title)).toEqual(
          before.map((row) => row.title),
        );
        expect(
          (
            await db
              .select()
              .from(softLawIngestionAttempts)
              .where(eq(softLawIngestionAttempts.sourceId, sourceId))
          ).some((attempt) => attempt.tag === "ambiguous_locator"),
        ).toBe(true);
      }));

    test("raw-write interruption retries only the interrupted item and reuses its content address", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        const keys: string[] = [];
        const sourceAdapter = adapter([
          entry(),
          entry("https://uoou.gov.cz/b", "Second", "03/2024"),
        ]);
        let interrupt = true;
        const writeRaw: WriteRawSourcePayload = async (options) => {
          const key = rawSourcePayloadKey(options);
          keys.push(key);
          if (interrupt && keys.length === 2) {
            throw new SoftLawAccessError({
              message: "Injected storage interruption",
            });
          }
          return key;
        };
        expect(await run(sourceAdapter, { writeRaw })).toEqual({
          status: "paused",
        });
        expect(
          await db
            .select()
            .from(softLawDocuments)
            .where(eq(softLawDocuments.sourceId, sourceId)),
        ).toHaveLength(1);
        interrupt = false;
        expect(await run(sourceAdapter, { writeRaw })).toEqual({
          status: "complete",
        });
        expect(new Set(keys).size).toBe(1);
        expect(keys).toHaveLength(3);
      }));

    test("failure after checkpoint persistence rolls back the entire page", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        let injected = false;
        const scopedDb: ScopedDb = async (work) =>
          await db.transaction(async (tx) => {
            const result = await work(tx);
            const current = (
              await tx
                .select()
                .from(softLawSources)
                .where(eq(softLawSources.id, sourceId))
            ).at(0);
            if (!injected && current?.syncCursor === "next") {
              injected = true;
              throw new SoftLawIngestionError({
                message: "Injected commit failure",
              });
            }
            return result;
          });
        const pages = {
          ...adapter([]),
          discover: async ({
            cursor,
          }: Parameters<SoftLawSourceAdapter["discover"]>[0]) =>
            cursor === null
              ? { entries: [entry()], nextCursor: "next" }
              : { entries: [], nextCursor: null },
        };
        expect((await run(pages, { scopedDb })).status).toBe("failed");
        expect(injected).toBe(true);
        expect(
          await db
            .select()
            .from(softLawDocuments)
            .where(eq(softLawDocuments.sourceId, sourceId)),
        ).toHaveLength(0);
        expect(
          (
            await db
              .select()
              .from(softLawSources)
              .where(eq(softLawSources.id, sourceId))
          ).at(0)?.syncCursor,
        ).toBeNull();
        expect(await run(pages)).toEqual({ status: "complete" });
        expect(
          await db
            .select()
            .from(softLawDocuments)
            .where(eq(softLawDocuments.sourceId, sourceId)),
        ).toHaveLength(1);
      }));

    test("an expired worker cannot overwrite the replacement worker's content", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        let entered!: () => void;
        const inside = new Promise<void>((resolve) => {
          entered = resolve;
        });
        let release!: () => void;
        const wait = new Promise<void>((resolve) => {
          release = resolve;
        });
        const slow = {
          ...adapter([entry()], "stale"),
          fetchDocument: async (item: SoftLawEntry) => {
            entered();
            await wait;
            return document(item, "stale");
          },
        };
        const stale = run(slow);
        await inside;
        try {
          await db
            .update(softLawSources)
            .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
            .where(eq(softLawSources.id, sourceId));
          expect(await run(adapter([entry()], "winner"))).toEqual({
            status: "complete",
          });
        } finally {
          release();
        }
        expect((await stale).status).toBe("failed");
        const versions = await db
          .select({ text: softLawDocumentVersions.extractedText })
          .from(softLawDocumentVersions)
          .innerJoin(
            softLawDocuments,
            eq(softLawDocumentVersions.documentId, softLawDocuments.id),
          )
          .where(eq(softLawDocuments.sourceId, sourceId));
        expect(versions).toEqual([{ text: "winner" }]);
        expect(
          (
            await db
              .select()
              .from(softLawSources)
              .where(eq(softLawSources.id, sourceId))
          ).at(0)?.runState,
        ).toBe("idle");
      }));

    test("migration forces RLS and the application role cannot read the source", async () =>
      await withSource(databaseUrl, async ({ db, sourceId }) => {
        const posture = await db.execute<{
          name: string;
          enabled: boolean;
          forced: boolean;
        }>(
          sql`SELECT relname AS name, relrowsecurity AS enabled, relforcerowsecurity AS forced FROM pg_class WHERE oid IN ('soft_law_sources'::regclass, 'soft_law_documents'::regclass, 'soft_law_document_versions'::regclass, 'soft_law_document_locators'::regclass, 'soft_law_ingestion_attempts'::regclass)`,
        );
        expect(posture).toHaveLength(5);
        expect(posture.every((row) => row.enabled && row.forced)).toBe(true);
        const grants = await db.execute<{ name: string; granted: boolean }>(
          sql`SELECT relname AS name, has_table_privilege('stella', oid, 'SELECT') AS granted FROM pg_class WHERE oid IN ('soft_law_sources'::regclass, 'soft_law_documents'::regclass, 'soft_law_document_versions'::regclass, 'soft_law_document_locators'::regclass, 'soft_law_ingestion_attempts'::regclass)`,
        );
        expect(grants.every((row) => !row.granted)).toBe(true);
        expect(
          await db
            .select()
            .from(softLawSources)
            .where(eq(softLawSources.id, sourceId)),
        ).toHaveLength(1);
      }));

    test("poison entries are final rejections while later entries still land", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        const poison = entry("https://uoou.gov.cz/poison", "");
        expect(await run(adapter([poison, entry()]))).toEqual({
          status: "complete",
        });
        expect(
          await db
            .select()
            .from(softLawDocuments)
            .where(eq(softLawDocuments.sourceId, sourceId)),
        ).toHaveLength(1);
        const attempts = await db
          .select()
          .from(softLawIngestionAttempts)
          .where(eq(softLawIngestionAttempts.sourceId, sourceId));
        expect(attempts.find((item) => item.url === poison.url)).toMatchObject({
          status: "rejected",
          tag: "invalid_document",
          count: 1,
        });
        expect(attempts.find((item) => item.url === entry().url)?.status).toBe(
          "applied",
        );
      }));

    test("retryable items hold the checkpoint, later items commit, and retries stop after three attempts", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        const poison = entry("https://uoou.gov.cz/poison");
        const later = entry("https://uoou.gov.cz/later", "Later", "03/2024");
        let poisonCalls = 0;
        let laterCalls = 0;
        const sourceAdapter = {
          ...adapter([poison, later]),
          fetchDocument: async (item: SoftLawEntry) => {
            if (item.url === poison.url) {
              poisonCalls++;
              throw new SoftLawAccessError({
                message: "Transient publisher failure",
              });
            }
            laterCalls++;
            return document(item);
          },
        };
        expect(await run(sourceAdapter)).toEqual({ status: "paused" });
        expect(
          await db
            .select()
            .from(softLawDocuments)
            .where(eq(softLawDocuments.sourceId, sourceId)),
        ).toHaveLength(1);
        expect(
          (
            await db
              .select()
              .from(softLawSources)
              .where(eq(softLawSources.id, sourceId))
          ).at(0)?.syncCursor,
        ).toBeNull();
        expect(await run(sourceAdapter)).toEqual({ status: "paused" });
        expect(await run(sourceAdapter)).toEqual({ status: "complete" });
        expect(poisonCalls).toBe(3);
        expect(laterCalls).toBe(1);
        expect(
          (
            await db
              .select()
              .from(softLawIngestionAttempts)
              .where(eq(softLawIngestionAttempts.sourceId, sourceId))
          ).find((item) => item.url === poison.url),
        ).toMatchObject({
          status: "rejected",
          tag: "retry_exhausted",
          count: 3,
        });
      }));

    test("pending retry receipts survive disappearance from the listing", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        const poison = entry("https://uoou.gov.cz/poison");
        const later = entry("https://uoou.gov.cz/later", "Later", "03/2024");
        let discovery = 0;
        let poisonCalls = 0;
        const sourceAdapter = {
          ...adapter([]),
          discover: async () => ({
            entries: discovery++ === 0 ? [poison, later] : [later],
            nextCursor: null,
          }),
          fetchDocument: async (item: SoftLawEntry) => {
            if (item.url === poison.url) {
              poisonCalls++;
              throw new SoftLawAccessError({ message: "Unavailable item" });
            }
            return document(item);
          },
        };
        expect(await run(sourceAdapter)).toEqual({ status: "paused" });
        expect(await run(sourceAdapter)).toEqual({ status: "paused" });
        expect(await run(sourceAdapter)).toEqual({ status: "complete" });
        expect(poisonCalls).toBe(3);
        expect(
          (
            await db
              .select()
              .from(softLawIngestionAttempts)
              .where(eq(softLawIngestionAttempts.sourceId, sourceId))
          ).find((attempt) => attempt.url === poison.url),
        ).toMatchObject({
          status: "rejected",
          tag: "retry_exhausted",
          count: 3,
          entry: poison,
        });
      }));

    test("oversized raw input is rejected before retaining or storing it, and later items land", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        const oversized = entry("https://uoou.gov.cz/oversized");
        const later = entry("https://uoou.gov.cz/later", "Later", "03/2024");
        let writes = 0;
        const sourceAdapter = {
          ...adapter([oversized, later]),
          fetchDocument: async (item: SoftLawEntry) => {
            const input = document(item);
            return item.url === oversized.url
              ? {
                  ...input,
                  raw: [
                    {
                      role: "page",
                      bytes: new Uint8Array(64 * 1024 * 1024 + 1),
                      contentType: "text/html",
                    },
                  ],
                }
              : input;
          },
        };
        expect(
          await run(sourceAdapter, {
            writeRaw: async (options) => {
              writes++;
              return rawSourcePayloadKey(options);
            },
          }),
        ).toEqual({ status: "complete" });
        expect(writes).toBe(1);
        expect(
          (
            await db
              .select()
              .from(softLawIngestionAttempts)
              .where(eq(softLawIngestionAttempts.sourceId, sourceId))
          ).find((attempt) => attempt.url === oversized.url),
        ).toMatchObject({ status: "rejected", tag: "invalid_document" });
      }));

    test("withdrawal and reversion with identical raw bytes preserve three metadata versions", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        const item = entry();
        const withdrawn = {
          ...item,
          metadata: {
            ...item.metadata,
            validity: { state: "withdrawn", basis: "source_stated" },
          },
        } as const satisfies SoftLawEntry;
        for (const listing of [[item], [withdrawn], [item]]) {
          expect(await run(adapter(listing))).toEqual({ status: "complete" });
        }
        const versions = await db
          .select({
            metadata: softLawDocumentVersions.metadata,
            rawObjects: softLawDocumentVersions.rawObjects,
          })
          .from(softLawDocumentVersions)
          .innerJoin(
            softLawDocuments,
            eq(softLawDocumentVersions.documentId, softLawDocuments.id),
          )
          .where(eq(softLawDocuments.sourceId, sourceId))
          .orderBy(softLawDocumentVersions.sequence);
        expect(versions.map((row) => row.metadata.validity.state)).toEqual([
          "not_stated",
          "withdrawn",
          "not_stated",
        ]);
        expect(
          new Set(versions.map((row) => JSON.stringify(row.rawObjects))).size,
        ).toBe(1);
      }));

    test("an empty maintenance listing and a declared-count shortfall cannot sweep retained documents", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        expect(await run(adapter([entry()]))).toEqual({ status: "complete" });
        const before = await db
          .select()
          .from(softLawDocuments)
          .where(eq(softLawDocuments.sourceId, sourceId));
        expect(
          (
            await run(
              {
                ...adapter([]),
                discover: async ({
                  fetch,
                }: Parameters<SoftLawSourceAdapter["discover"]>[0]) => {
                  await fetch("https://uoou.gov.cz/listing");
                  return { entries: [], nextCursor: null };
                },
              },
              {
                request: async () =>
                  new Response("<title>Maintenance</title>", {
                    headers: { "content-type": "text/html" },
                  }),
              },
            )
          ).status,
        ).toBe("failed");
        expect(
          await db
            .select()
            .from(softLawDocuments)
            .where(eq(softLawDocuments.sourceId, sourceId)),
        ).toEqual(before);
        expect(
          (
            await db
              .select()
              .from(softLawSources)
              .where(eq(softLawSources.id, sourceId))
          ).at(0)?.failureTag,
        ).toBe("listing_incomplete");
        expect(
          (
            await run({
              ...adapter([entry()]),
              getTotalCount: async () => ({ type: "count", total: 2 }),
            })
          ).status,
        ).toBe("failed");
        expect(
          await db
            .select()
            .from(softLawDocuments)
            .where(eq(softLawDocuments.sourceId, sourceId)),
        ).toEqual(before);
      }));

    test("swallowing or wrapping a block cannot hide the latch or issue another request", async () => {
      for (const mode of ["swallowed", "wrapped"] as const) {
        await withSource(databaseUrl, async ({ db, sourceId, run }) => {
          let requests = 0;
          let refused = 0;
          const sourceAdapter = {
            ...adapter([entry()]),
            fetchDocument: async (
              item: SoftLawEntry,
              { fetch }: Parameters<SoftLawSourceAdapter["fetchDocument"]>[1],
            ) => {
              const first = await Result.tryPromise(() => fetch(item.url));
              const second = await Result.tryPromise(() => fetch(item.url));
              if (Result.isError(second)) {
                refused++;
              }
              if (mode === "wrapped" && Result.isError(first)) {
                throw new SoftLawIngestionError({
                  message: "Wrapped publisher failure",
                });
              }
              return document(item);
            },
          };
          expect(
            await run(sourceAdapter, {
              request: async () => {
                requests++;
                return new Response("blocked", { status: 429 });
              },
            }),
          ).toEqual({ status: "blocked", reason: "rate_limited" });
          expect(requests).toBe(1);
          expect(refused).toBe(1);
          expect(
            await db
              .select()
              .from(softLawDocuments)
              .where(eq(softLawDocuments.sourceId, sourceId)),
          ).toHaveLength(0);
          expect(
            (
              await db
                .select()
                .from(softLawSources)
                .where(eq(softLawSources.id, sourceId))
            ).at(0)?.failureTag,
          ).toBe("rate_limited");
        });
      }
    });

    test("a closed publisher window pauses the source with a typed reason", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        const sourceAdapter = {
          ...adapter([]),
          access: {
            ...adapter([]).access,
            window: {
              type: "off_peak",
              timeZone: "Europe/Prague",
              startHour: 22,
              endHour: 6,
            },
          },
          discover: async ({
            fetch,
          }: Parameters<SoftLawSourceAdapter["discover"]>[0]) => {
            await fetch(entry().url);
            return { entries: [], nextCursor: null };
          },
        } as const satisfies SoftLawSourceAdapter;
        expect(
          await run(sourceAdapter, {
            now: () => new Date("2026-10-02T12:00:00Z"),
          }),
        ).toEqual({ status: "paused", reason: "deferred_window" });
        expect(
          (
            await db
              .select()
              .from(softLawSources)
              .where(eq(softLawSources.id, sourceId))
          ).at(0),
        ).toMatchObject({ failureTag: "deferred_window", leaseToken: null });
      }));

    test("a dead holder remains busy until lease expiry and resumed observations use transaction time", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        const store = createSoftLawIngestionStore({
          sourceId,
          adapter: { ...adapter([]), key: `soft-law-test-${sourceId}` },
          scopedDb: async (work) => await db.transaction(work),
        });
        expect((await store.claim()).type).toBe("claimed");
        expect(await run(adapter([entry()]))).toEqual({ status: "busy" });
        const old = new Date("2020-01-01T00:00:00Z");
        await db
          .update(softLawSources)
          .set({
            runStartedAt: old,
            leaseExpiresAt: sql`now() - interval '1 second'`,
          })
          .where(eq(softLawSources.id, sourceId));
        expect(await run(adapter([entry()]))).toEqual({ status: "complete" });
        const docs = await db
          .select()
          .from(softLawDocuments)
          .where(eq(softLawDocuments.sourceId, sourceId));
        expect(docs.at(0)?.lastSeenAt.getTime()).toBeGreaterThan(old.getTime());
        const versions = await db
          .select({ observedFrom: softLawDocumentVersions.observedFrom })
          .from(softLawDocumentVersions)
          .innerJoin(
            softLawDocuments,
            eq(softLawDocumentVersions.documentId, softLawDocuments.id),
          )
          .where(eq(softLawDocuments.sourceId, sourceId));
        expect(versions.at(0)?.observedFrom).toEqual(docs.at(0)?.lastSeenAt);
      }));

    test("database calls stay constant as a page grows", async () => {
      const calls: number[] = [];
      for (const size of [1, 8]) {
        await withSource(databaseUrl, async ({ db, run }) => {
          let count = 0;
          const scopedDb: ScopedDb = async (work) => {
            count++;
            return await db.transaction(work);
          };
          const items = Array.from({ length: size }, (_, i) =>
            entry(`https://uoou.gov.cz/${i}`, `Guidance ${i}`, `${i}/2024`),
          );
          expect(await run(adapter(items), { scopedDb })).toEqual({
            status: "complete",
          });
          calls.push(count);
        });
      }
      expect(calls.at(0)).toBe(calls.at(1));
    });

    test("all reader roles lack every soft-law operation; ingestion can write only operational data", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        const roles = [
          "stella",
          stellaCaseLawReader.name,
          stellaPublicLawReader.name,
          stellaCaseLawAnalysisReader.name,
          stellaCorpusSampleReader.name,
        ];
        const tables = [
          "soft_law_sources",
          "soft_law_documents",
          "soft_law_document_versions",
          "soft_law_document_locators",
          "soft_law_ingestion_attempts",
        ];
        for (const role of roles) {
          for (const table of tables) {
            for (const statement of [
              `SELECT * FROM ${table}`,
              `INSERT INTO ${table} DEFAULT VALUES`,
              `UPDATE ${table} SET id = id`,
              `DELETE FROM ${table}`,
            ]) {
              const denied = await Result.tryPromise(() =>
                db.transaction(async (tx) => {
                  await tx.execute(sql.raw(`SET LOCAL ROLE "${role}"`));
                  await tx.execute(sql.raw(statement));
                }),
              );
              expect(Result.isError(denied)).toBe(true);
              if (Result.isError(denied)) {
                expect(permissionDenied(denied.error.cause)).toBe(true);
              }
            }
          }
        }
        const scopedDb: ScopedDb = async (work) =>
          await db.transaction(async (tx) => {
            await tx.execute(
              sql.raw(`SET LOCAL ROLE "${stellaIngestion.name}"`),
            );
            return await work(tx);
          });
        expect(await run(adapter([entry()]), { scopedDb })).toEqual({
          status: "complete",
        });
        expect(await run(adapter([entry()], "updated"), { scopedDb })).toEqual({
          status: "complete",
        });
        for (const statement of [
          `UPDATE soft_law_sources SET descriptor = '{}'::jsonb WHERE id = '${sourceId}'`,
          "DELETE FROM soft_law_documents",
        ]) {
          const denied = await Result.tryPromise(() =>
            db.transaction(async (tx) => {
              await tx.execute(
                sql.raw(`SET LOCAL ROLE "${stellaIngestion.name}"`),
              );
              await tx.execute(sql.raw(statement));
            }),
          );
          expect(Result.isError(denied)).toBe(true);
          if (Result.isError(denied)) {
            expect(permissionDenied(denied.error.cause)).toBe(true);
          }
        }
        const supersessionColumn = await db.execute(
          sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'soft_law_documents' AND column_name = 'superseded_by'`,
        );
        expect(supersessionColumn).toHaveLength(0);
        const unknownFailure = await Result.tryPromise(() =>
          db.execute(
            sql`UPDATE soft_law_sources SET failure_tag = 'unknown_failure' WHERE id = ${sourceId}`,
          ),
        );
        expect(Result.isError(unknownFailure)).toBe(true);
      }));

    test("undated unnumbered title collisions are rejected and replay cannot churn versions", async () =>
      await assertProperty(
        "soft-law unnumbered identity collision is stable",
        fc.asyncProperty(
          fc
            .string({ minLength: 1, maxLength: 30 })
            .filter((value) => value.trim().length > 0),
          fc.uniqueArray(fc.uuid(), { minLength: 2, maxLength: 2 }),
          async (title, contents) =>
            await withSource(databaseUrl, async ({ db, sourceId, run }) => {
              const items = ["a", "b"].map((slug) => ({
                url: `https://uoou.gov.cz/${slug}`,
                metadata: {
                  title,
                  kind: "recommendation" as const,
                  statedReference: { state: "not_stated" as const },
                  issuedOn: { state: "not_stated" as const },
                  validity: {
                    state: "not_stated" as const,
                    basis: "source_stated" as const,
                  },
                },
                sourceDates: {},
              }));
              const sourceAdapter = {
                ...adapter(items),
                fetchDocument: async (item: SoftLawEntry) =>
                  document(
                    item,
                    (item.url.endsWith("/a")
                      ? contents.at(0)
                      : contents.at(1)) ?? panic("Generator omitted content"),
                  ),
              };
              for (let round = 0; round < 2; round++) {
                expect(await run(sourceAdapter)).toEqual({
                  status: "complete",
                });
              }
              const docs = await db
                .select()
                .from(softLawDocuments)
                .where(eq(softLawDocuments.sourceId, sourceId));
              expect(docs).toHaveLength(1);
              const versions = await db
                .select()
                .from(softLawDocumentVersions)
                .innerJoin(
                  softLawDocuments,
                  eq(softLawDocumentVersions.documentId, softLawDocuments.id),
                )
                .where(eq(softLawDocuments.sourceId, sourceId));
              expect(versions).toHaveLength(1);
              const attempts = await db
                .select()
                .from(softLawIngestionAttempts)
                .where(eq(softLawIngestionAttempts.sourceId, sourceId));
              expect(
                attempts.filter(
                  (attempt) => attempt.tag === "identity_collision",
                ),
              ).toHaveLength(2);
            }),
        ),
        { numRuns: 8 },
      ));

    test("soft-law observation replay is idempotent", async () =>
      await assertProperty(
        "soft-law observation replay is idempotent",
        fc.asyncProperty(
          fc.array(
            fc.record({
              reference: fc.uuid(),
              title: fc
                .string({ minLength: 1, maxLength: 30 })
                .filter((title) => title.trim().length > 0),
            }),
            { minLength: 1, maxLength: 5 },
          ),
          async (items) =>
            await withSource(databaseUrl, async ({ db, sourceId, run }) => {
              const listing = items.map((item) =>
                entry(
                  `https://uoou.gov.cz/${item.reference}`,
                  item.title,
                  item.reference,
                ),
              );
              expect(await run(adapter(listing))).toEqual({
                status: "complete",
              });
              const before = await db
                .select({ id: softLawDocuments.id })
                .from(softLawDocuments)
                .where(eq(softLawDocuments.sourceId, sourceId));
              expect(await run(adapter(listing))).toEqual({
                status: "complete",
              });
              const after = await db
                .select({ id: softLawDocuments.id })
                .from(softLawDocuments)
                .where(eq(softLawDocuments.sourceId, sourceId));
              expect(after.map((row) => row.id).toSorted()).toEqual(
                before.map((row) => row.id).toSorted(),
              );
              expect(after).toHaveLength(
                new Set(items.map((item) => item.reference)).size,
              );
              const versions = await db
                .select()
                .from(softLawDocumentVersions)
                .innerJoin(
                  softLawDocuments,
                  eq(softLawDocumentVersions.documentId, softLawDocuments.id),
                )
                .where(eq(softLawDocuments.sourceId, sourceId));
              const locators = await db
                .select()
                .from(softLawDocumentLocators)
                .innerJoin(
                  softLawDocuments,
                  eq(softLawDocumentLocators.documentId, softLawDocuments.id),
                )
                .where(eq(softLawDocuments.sourceId, sourceId));
              expect(versions).toHaveLength(after.length);
              expect(locators).toHaveLength(after.length);
              expect(
                (
                  await db
                    .select()
                    .from(softLawSources)
                    .where(eq(softLawSources.id, sourceId))
                ).at(0),
              ).toMatchObject({
                syncCursor: null,
                runState: "idle",
                leaseToken: null,
              });
            }),
        ),
        { numRuns: 8 },
      ));
  });
}
