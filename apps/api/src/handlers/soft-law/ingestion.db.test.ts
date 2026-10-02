import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import fc from "fast-check";

import type { fetchWithTimeout } from "@stll/fetch";
import { assertProperty } from "@stll/property-testing";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  softLawSources,
  softLawDocuments,
  softLawDocumentVersions,
  softLawDocumentLocators,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { rawSourcePayloadKey } from "@/api/lib/legal-search/raw-source-storage";
import type { WriteRawSourcePayload } from "@/api/lib/legal-search/raw-source-storage";
import type {
  SoftLawSourceAdapter,
  SoftLawEntry,
  SoftLawDocumentInput,
} from "@/api/lib/legal-search/soft-law-types";
import { SoftLawIngestionError } from "@/api/lib/legal-search/soft-law-types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";

import { runSoftLawIngestion } from "./ingestion";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
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
        },
      });
    try {
      await fn({ db, sourceId, run });
    } finally {
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

    test("a vanished entry is retained with its last-seen date", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        const item = entry(undefined, Bun.randomUUIDv7());
        await run(adapter([item]));
        const before = (
          await db
            .select()
            .from(softLawDocuments)
            .where(eq(softLawDocuments.sourceId, sourceId))
        ).at(0);
        expect(before).toBeDefined();
        expect(await run(adapter([]))).toEqual({ status: "complete" });
        const after = (
          await db
            .select()
            .from(softLawDocuments)
            .where(eq(softLawDocuments.sourceId, sourceId))
        ).at(0);
        expect(after?.listingState).toBe("no_longer_listed");
        expect(after?.lastSeenAt).toEqual(before?.lastSeenAt);
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

    test("a renamed unnumbered document retains its identity through its locator", async () =>
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
        expect(after.at(0)?.title).toBe("Renamed guidance");
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
        ).toBe("failed");
        expect(
          await db
            .select()
            .from(softLawDocuments)
            .where(eq(softLawDocuments.sourceId, sourceId)),
        ).toEqual(before);
      }));

    test("raw-write interruption holds the checkpoint and reuses the content address", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        const first = entry();
        const second = entry("https://uoou.gov.cz/b", "Second", "03/2024");
        const keys: string[] = [];
        const sourceAdapter = adapter([first, second]);
        const writeRaw: WriteRawSourcePayload = async (options) => {
          const key = rawSourcePayloadKey(options);
          keys.push(key);
          return key;
        };
        expect(
          (
            await run(
              {
                ...sourceAdapter,
                fetchDocument: async (item) => {
                  if (item.url === second.url) {
                    throw new SoftLawIngestionError({
                      message: "Interrupted after raw write",
                    });
                  }
                  return document(item);
                },
              },
              { writeRaw },
            )
          ).status,
        ).toBe("failed");
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
          sql`SELECT relname AS name, relrowsecurity AS enabled, relforcerowsecurity AS forced FROM pg_class WHERE oid IN ('soft_law_sources'::regclass, 'soft_law_documents'::regclass, 'soft_law_document_versions'::regclass, 'soft_law_document_locators'::regclass)`,
        );
        expect(posture).toHaveLength(4);
        expect(posture.every((row) => row.enabled && row.forced)).toBe(true);
        const grants = await db.execute<{ name: string; granted: boolean }>(
          sql`SELECT relname AS name, has_table_privilege('stella', oid, 'SELECT') AS granted FROM pg_class WHERE oid IN ('soft_law_sources'::regclass, 'soft_law_documents'::regclass, 'soft_law_document_versions'::regclass, 'soft_law_document_locators'::regclass)`,
        );
        expect(grants.every((row) => !row.granted)).toBe(true);
        expect(
          await db
            .select()
            .from(softLawSources)
            .where(eq(softLawSources.id, sourceId)),
        ).toHaveLength(1);
      }));

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
