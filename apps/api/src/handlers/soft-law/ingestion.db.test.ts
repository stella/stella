import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import fc from "fast-check";

import type { fetchWithTimeout } from "@stll/fetch";
import { assertProperty } from "@stll/property-testing";

import {
  stellaCaseLawAnalysisReader,
  stellaCaseLawReader,
  stellaCorpusSampleReader,
  stellaIngestion,
  stellaPublicLawReader,
} from "@/api/db/rls";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  softLawDocumentLocators,
  softLawDocuments,
  softLawDocumentVersions,
  softLawIngestionAttempts,
  softLawSources,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { createTextPdf } from "@/api/lib/files/text-pdf";
import { rawSourcePayloadKey } from "@/api/lib/legal-search/raw-source-storage";
import type { WriteRawSourcePayload } from "@/api/lib/legal-search/raw-source-storage";
import { SoftLawAccessError } from "@/api/lib/legal-search/soft-law-access-types";
import { createSoftLawIngestionStore } from "@/api/lib/legal-search/soft-law-ingestion-store";
import type {
  SoftLawDocumentInput,
  SoftLawEntry,
  SoftLawSourceAdapter,
} from "@/api/lib/legal-search/soft-law-types";
import {
  SoftLawIngestionError,
  storedSoftLawDiscoveryEntry,
} from "@/api/lib/legal-search/soft-law-types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";

import { parseWp29Archive, wp29Adapter } from "./adapters/wp29";
import { runSoftLawIngestion } from "./ingestion";

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
  type: "document",
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
const document = (item: SoftLawEntry, content = "original") =>
  ({
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
  }) as const satisfies SoftLawDocumentInput;
const adapter = (entries: readonly SoftLawEntry[], content = "original") =>
  ({
    key: "soft-law-test",
    authority: "cz-uoou",
    access: {
      publisherGate: "uoou-cz",
      userAgent: "Stella/1.0 (+https://stella.example/contact)",
      window: { type: "any_time" },
    },
    discover: async () => Result.ok({ entries, nextCursor: null }),
    fetchDocument: async (item) => Result.ok(document(item, content)),
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

test("legacy retry receipts have a replayable document-entry migration", async () => {
  const migration = await Bun.file(
    new URL(
      "../../../drizzle/20261019090100_soft_law_legacy_receipt_entry_type/migration.sql",
      import.meta.url,
    ),
  ).text();
  expect(migration).toContain(
    `SET "entry" = jsonb_set("entry", '{type}', '"document"', true)`,
  );
  expect(migration).toContain(
    `WHERE "status" = 'retryable' AND "entry"->>'type' IS NULL`,
  );
});

test("a retry receipt written without its entry type after the migration still resumes as a document", () => {
  // An older worker can still write this shape while a deployment rolls out.
  const { type: _type, ...legacy } = entry();
  const current = entry();
  expect(storedSoftLawDiscoveryEntry(legacy)).toEqual(current);
  expect(storedSoftLawDiscoveryEntry(current)).toBe(current);
});

if (!databaseUrl || !enabled) {
  describe.skip("guidance ingestion on real Postgres", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS and DATABASE_URL", () => {});
  });
} else {
  describe("guidance ingestion on real Postgres", () => {
    test("a Czech document stored under the historical reference key is matched on re-ingestion", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        const item = entry();
        const documentId = createSafeId<"softLawDocument">();
        await db.insert(softLawDocuments).values({
          id: documentId,
          sourceId,
          identityKey: JSON.stringify(["cz-uoou", "reference", "02/2024"]),
          jurisdiction: "CZE",
          authority: "cz-uoou",
          kind: item.metadata.kind,
          title: item.metadata.title,
          statedReference: "02/2024",
          statedReferenceState: "stated",
          issuedOn: null,
          issuedOnState: "not_stated",
          listingState: "listed",
          validityState: "not_stated",
          validityBasis: "source_stated",
          firstSeenAt: new Date(),
          lastSeenAt: new Date(),
          lastSeenRun: Bun.randomUUIDv7(),
        });

        expect(await run(adapter([item]))).toEqual({ status: "complete" });
        const stored = await db
          .select()
          .from(softLawDocuments)
          .where(eq(softLawDocuments.sourceId, sourceId));
        expect(stored).toHaveLength(1);
        expect(stored.at(0)?.id).toBe(documentId);
      }));

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
              return Result.ok({ entries: [first], nextCursor: "second" });
            }
            if (fail) {
              return Result.err(
                new SoftLawIngestionError({
                  message: "Injected interruption",
                }),
              );
            }
            return Result.ok({ entries: [second], nextCursor: null });
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

    test("a rejected discovery entry advances the cursor without creating document rows", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        const cursors: (string | null)[] = [];
        let documentFetches = 0;
        const sourceRaw = [
          {
            role: "detail",
            contentBase64: Buffer.from("malformed detail").toBase64(),
            contentType: "text/html",
          },
        ];
        const sourceAdapter = {
          ...adapter([]),
          discover: async ({ cursor }) => {
            cursors.push(cursor);
            return Result.ok(
              cursor === null
                ? {
                    entries: [
                      {
                        type: "rejected" as const,
                        url: "https://www.edpb.europa.eu/malformed-detail",
                        sourceRaw,
                        rejection: {
                          tag: "invalid_document" as const,
                          reason: "EDPB document language is not stated",
                        },
                      },
                    ],
                    nextCursor: "after-rejection",
                  }
                : { entries: [], nextCursor: null },
            );
          },
          fetchDocument: async (item: SoftLawEntry) => {
            documentFetches++;
            return Result.ok(document(item));
          },
        } satisfies SoftLawSourceAdapter;

        expect(await run(sourceAdapter)).toEqual({ status: "complete" });
        expect(cursors).toEqual([null, "after-rejection"]);
        expect(documentFetches).toBe(0);
        expect(
          await db
            .select()
            .from(softLawDocuments)
            .where(eq(softLawDocuments.sourceId, sourceId)),
        ).toHaveLength(0);
        expect(
          await db
            .select()
            .from(softLawDocumentVersions)
            .innerJoin(
              softLawDocuments,
              eq(softLawDocumentVersions.documentId, softLawDocuments.id),
            )
            .where(eq(softLawDocuments.sourceId, sourceId)),
        ).toHaveLength(0);
        expect(
          (
            await db
              .select()
              .from(softLawIngestionAttempts)
              .where(eq(softLawIngestionAttempts.sourceId, sourceId))
          ).at(0),
        ).toMatchObject({
          status: "rejected",
          tag: "invalid_document",
          entry: {
            type: "rejected",
            sourceRaw,
            rejection: {
              tag: "invalid_document",
              reason: "EDPB document language is not stated",
            },
          },
        });
      }));

    test("a malformed WP29 detail is recorded while a later publication is ingested across resumed runs", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        const indexUrl =
          "https://ec.europa.eu/newsroom/article29/items/itemType/1360";
        const malformedUrl =
          "https://ec.europa.eu/newsroom/article29/redirection/item/1";
        const validUrl =
          "https://ec.europa.eu/newsroom/article29/redirection/item/2";
        const pdfUrl =
          "https://ec.europa.eu/newsroom/article29/files/valid.pdf";
        const listing = `<div id="leftentityselect"></div><main id="main-content"><a href="${malformedUrl}">Malformed</a><a href="${validUrl}">Valid</a></main>`;
        const detail = (language: string) =>
          `<main id="main-content"><h1 class="ecl-page-header__title">Guidelines WP 123</h1><div class="ecl-file"><span class="ecl-file__meta">PDF</span><span class="ecl-file__language">${language}</span><a class="ecl-file__download" href="${pdfUrl}">Download</a></div></main>`;
        const responses = new Map([
          [indexUrl, { body: listing, contentType: "text/html" }],
          [malformedUrl, { body: detail("Unknown"), contentType: "text/html" }],
          [validUrl, { body: detail("English"), contentType: "text/html" }],
          [pdfUrl, { body: "%PDF-1.4\n%%EOF", contentType: "application/pdf" }],
        ]);
        const requested: string[] = [];
        const request: typeof fetchWithTimeout = async (input) => {
          let url: string;
          if (typeof input === "string") {
            url = input;
          } else if (input instanceof URL) {
            url = input.href;
          } else {
            url = input.url;
          }
          requested.push(url);
          const response = responses.get(url);
          if (!response) {
            return new Response("missing", { status: 404 });
          }
          return new Response(response.body, {
            headers: { "content-type": response.contentType },
          });
        };
        const sourceAdapter = {
          ...wp29Adapter,
          discover: async (
            options: Parameters<SoftLawSourceAdapter["discover"]>[0],
          ) => {
            const cursor = options.cursor ?? "newsroom:0:0";
            const result = await wp29Adapter.discover({ ...options, cursor });
            if (result.isErr() || cursor !== "newsroom:0:1") {
              return result;
            }
            return Result.ok({ ...result.value, nextCursor: null });
          },
        } satisfies SoftLawSourceAdapter;

        expect(await run(sourceAdapter, { request })).toEqual({
          status: "complete",
        });
        expect(await run(sourceAdapter, { request })).toEqual({
          status: "complete",
        });
        expect(requested.filter((url) => url === malformedUrl)).toHaveLength(2);
        expect(requested.filter((url) => url === validUrl)).toHaveLength(2);
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
              .from(softLawIngestionAttempts)
              .where(eq(softLawIngestionAttempts.sourceId, sourceId))
          ).find((attempt) => attempt.url === malformedUrl),
        ).toMatchObject({
          status: "rejected",
          tag: "invalid_document",
          entry: { type: "rejected", url: malformedUrl },
        });
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
            return Result.ok({ entries: [item], nextCursor: null });
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
            const response = await fetch("https://uoou.gov.cz/a");
            if (Result.isError(response)) {
              return Result.err(response.error);
            }
            return Result.ok({ entries: [], nextCursor: null });
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
            Result.ok(
              cursor === null
                ? { entries: [entry()], nextCursor: "next" }
                : { entries: [], nextCursor: null },
            ),
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
            return Result.ok(document(item, "stale"));
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
              return Result.err(
                new SoftLawAccessError({
                  message: "Transient publisher failure",
                }),
              );
            }
            laterCalls++;
            return Result.ok(document(item));
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
          discover: async () =>
            Result.ok({
              entries: discovery++ === 0 ? [poison, later] : [later],
              nextCursor: null,
            }),
          fetchDocument: async (item: SoftLawEntry) => {
            if (item.url === poison.url) {
              poisonCalls++;
              return Result.err(
                new SoftLawAccessError({ message: "Unavailable item" }),
              );
            }
            return Result.ok(document(item));
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

    test("a migrated legacy retry receipt resumes with the strict entry decoder", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        const item = entry("https://uoou.gov.cz/legacy-retry");
        let calls = 0;
        const sourceAdapter = {
          ...adapter([item]),
          fetchDocument: async (candidate: SoftLawEntry) => {
            calls++;
            return calls === 1
              ? Result.err(
                  new SoftLawAccessError({ message: "Temporary failure" }),
                )
              : Result.ok(document(candidate));
          },
        } satisfies SoftLawSourceAdapter;
        expect(await run(sourceAdapter)).toEqual({ status: "paused" });
        await db.execute(
          sql`UPDATE soft_law_ingestion_attempts SET entry = entry - 'type' WHERE source_id = ${sourceId}`,
        );
        const migration = await Bun.file(
          new URL(
            "../../../drizzle/20261019090100_soft_law_legacy_receipt_entry_type/migration.sql",
            import.meta.url,
          ),
        ).text();
        const update = /UPDATE "soft_law_ingestion_attempts"[\s\S]*?;/u
          .exec(migration)
          ?.at(0);
        if (!update) {
          panic("Legacy receipt migration has no update");
        }
        await db.execute(sql.raw(update));

        expect(
          await run({ ...sourceAdapter, discover: adapter([]).discover }),
        ).toEqual({
          status: "complete",
        });
        expect(calls).toBe(2);
      }));

    test.each([
      {
        name: "failed extraction",
        extraction: {
          extractionQuality: "extraction_failed",
          extractionFailure: "PDF extraction failed",
        } as const,
      },
      {
        name: "scan needing OCR",
        extraction: { extractionQuality: "needs_ocr" } as const,
      },
    ])(
      "a textless WP29 $name without a reference stores raw bytes and repairs its identity",
      async ({ extraction }) =>
        await withSource(databaseUrl, async ({ db, sourceId, run }) => {
          const item = {
            type: "document",
            url: "https://ec.europa.eu/justice/article-29/example.doc",
            metadata: {
              title: "Transparency opinion",
              kind: "opinion",
              sourceKind: "Transparency opinion",
              statedReference: { state: "not_stated" },
              issuedOn: { state: "not_stated" },
              expression: {
                type: "identified",
                language: "en",
                revision: { state: "not_stated" },
              },
              stage: { state: "not_stated" },
              relations: [],
              validity: {
                state: "not_stated",
                basis: "archived_source_stated",
              },
            },
            sourceDates: {},
          } as const satisfies SoftLawEntry;
          let repaired = false;
          const sourceAdapter = {
            ...adapter([item]),
            authority: "eu-wp29",
            fetchDocument: async () => {
              const raw = [
                {
                  role: "document-pdf",
                  purpose: "document",
                  bytes: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]),
                  contentType: "application/pdf",
                },
              ] as const;
              if (!repaired) {
                repaired = true;
                return Result.ok({
                  metadata: item.metadata,
                  raw,
                  text: null,
                  ...extraction,
                  sourceDates: {},
                });
              }
              return Result.ok({
                metadata: {
                  ...item.metadata,
                  statedReference: { state: "stated", value: "WP 260" },
                  expression: {
                    ...item.metadata.expression,
                    revision: { state: "stated", value: "rev.01" },
                  },
                },
                raw,
                text: "WP 260 Transparency opinion",
                extractionQuality: "text_layer",
                sourceDates: {},
              });
            },
          } satisfies SoftLawSourceAdapter;

          expect(await run(sourceAdapter)).toEqual({ status: "complete" });
          const placeholderVersions = await db
            .select()
            .from(softLawDocumentVersions)
            .innerJoin(
              softLawDocuments,
              eq(softLawDocumentVersions.documentId, softLawDocuments.id),
            )
            .where(eq(softLawDocuments.sourceId, sourceId));
          expect(placeholderVersions).toHaveLength(1);
          expect(
            placeholderVersions.at(0)?.soft_law_document_versions,
          ).toMatchObject({
            extractionQuality: extraction.extractionQuality,
            extractedText: null,
            rawObjects: [
              expect.objectContaining({
                role: "document-pdf",
                contentType: "application/pdf",
              }),
            ],
          });
          expect(await run(sourceAdapter)).toEqual({ status: "complete" });
          const stored = await db
            .select()
            .from(softLawDocuments)
            .where(eq(softLawDocuments.sourceId, sourceId));
          expect(stored).toHaveLength(1);
          expect(stored.at(0)?.statedReference).toBe("WP 260");
          expect(stored.at(0)?.identityKey).toContain("wp260");
          expect(stored.at(0)?.identityKey).toContain("rev1");
          const documentId = stored.at(0)?.id;
          if (!documentId) {
            panic("Repaired WP29 document was not stored");
          }
          const versions = await db
            .select()
            .from(softLawDocumentVersions)
            .where(eq(softLawDocumentVersions.documentId, documentId));
          expect(
            versions.map(({ extractionQuality }) => extractionQuality),
          ).toEqual([extraction.extractionQuality, "text_layer"]);
        }),
    );

    test("a mixed unnumbered WP29 row stores an extraction placeholder with every raw asset", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        const wordUrl =
          "https://ec.europa.eu/justice/article-29/documentation/opinion-recommendation/files/2018/mixed_en.doc";
        const pdfUrl =
          "https://ec.europa.eu/justice/article-29/documentation/opinion-recommendation/files/2018/mixed_en.pdf";
        const html = `<div class="contentsection block"><h2>2018</h2><ul><li><a class="link-ico" href="${wordUrl}"><span>Transparency opinion</span></a><a class="link-ico" href="${pdfUrl}"><span>Transparency opinion PDF</span></a></li></ul></div>`;
        const parsed = parseWp29Archive(html).unwrap().at(0);
        if (!parsed) {
          panic("Mixed WP29 database entry was not parsed");
        }
        const wordBytes = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]);
        const pdfBytes = createTextPdf(
          "Transparency opinion",
          "A readable opinion without an instrument number",
        );
        const sourceAdapter = {
          ...wp29Adapter,
          discover: async () =>
            Result.ok({
              entries: [
                {
                  ...parsed,
                  sourceRaw: [
                    {
                      role: "source-page-0",
                      contentBase64: Buffer.from(html).toBase64(),
                      contentType: "text/html",
                    },
                  ],
                },
              ],
              nextCursor: null,
            }),
        } satisfies SoftLawSourceAdapter;
        const written = new Map<string, Uint8Array>();
        const request: typeof fetchWithTimeout = async (input) => {
          let url: string;
          if (typeof input === "string") {
            url = input;
          } else if (input instanceof URL) {
            url = input.href;
          } else {
            url = input.url;
          }
          if (url === wordUrl) {
            return new Response(wordBytes, {
              headers: { "content-type": "application/msword" },
            });
          }
          if (url === pdfUrl) {
            return new Response(pdfBytes, {
              headers: { "content-type": "application/pdf" },
            });
          }
          return new Response("missing", { status: 404 });
        };

        expect(
          await run(sourceAdapter, {
            request,
            writeRaw: async (options) => {
              const key = rawSourcePayloadKey(options);
              written.set(
                key,
                typeof options.data === "string"
                  ? new TextEncoder().encode(options.data)
                  : options.data,
              );
              return key;
            },
          }),
        ).toEqual({ status: "complete" });
        const stored = await db
          .select()
          .from(softLawDocumentVersions)
          .innerJoin(
            softLawDocuments,
            eq(softLawDocumentVersions.documentId, softLawDocuments.id),
          )
          .where(eq(softLawDocuments.sourceId, sourceId));
        expect(stored).toHaveLength(1);
        expect(stored.at(0)?.soft_law_document_versions).toMatchObject({
          extractionQuality: "extraction_failed",
          extractedText: null,
          rawObjects: [
            expect.objectContaining({ role: "source-page-0" }),
            expect.objectContaining({ role: "document-word" }),
            expect.objectContaining({ role: "document-pdf-1" }),
          ],
        });
        expect([...written.values()]).toContainEqual(wordBytes);
        expect([...written.values()]).toContainEqual(pdfBytes);
      }));

    test.each([
      {
        name: "stated revision changes",
        storedExpression: {
          type: "identified",
          language: "en",
          revision: { state: "stated", value: "rev.01" },
        },
        recoveredExpression: {
          type: "identified",
          language: "en",
          revision: { state: "stated", value: "rev.02" },
        },
      },
      {
        name: "language changes",
        storedExpression: {
          type: "identified",
          language: "en",
          revision: { state: "not_stated" },
        },
        recoveredExpression: {
          type: "identified",
          language: "de",
          revision: { state: "stated", value: "rev.01" },
        },
      },
    ] as const)(
      "a WP29 extraction placeholder stays ambiguous when its $name",
      async ({ storedExpression, recoveredExpression }) =>
        await withSource(databaseUrl, async ({ db, sourceId, run }) => {
          const item = {
            type: "document",
            url: "https://ec.europa.eu/justice/article-29/expression.doc",
            metadata: {
              title: "Expression-sensitive opinion",
              kind: "opinion",
              sourceKind: "Expression-sensitive opinion",
              statedReference: { state: "not_stated" },
              issuedOn: { state: "not_stated" },
              expression: storedExpression,
              stage: { state: "not_stated" },
              relations: [],
              validity: {
                state: "not_stated",
                basis: "archived_source_stated",
              },
            },
            sourceDates: {},
          } as const satisfies SoftLawEntry;
          let repaired = false;
          const sourceAdapter = {
            ...adapter([item]),
            authority: "eu-wp29",
            fetchDocument: async () => {
              const common = {
                raw: [
                  {
                    role: "document-word",
                    purpose: "document" as const,
                    bytes: new TextEncoder().encode("WP 260"),
                    contentType: "application/msword",
                  },
                ],
                sourceDates: {},
              };
              if (!repaired) {
                repaired = true;
                return Result.ok({
                  ...common,
                  metadata: item.metadata,
                  text: null,
                  extractionQuality: "extraction_failed",
                  extractionFailure: "Binary Word extraction failed",
                });
              }
              return Result.ok({
                ...common,
                metadata: {
                  ...item.metadata,
                  statedReference: { state: "stated", value: "WP 260" },
                  expression: recoveredExpression,
                },
                text: "WP 260 extracted",
                extractionQuality: "text_layer",
              });
            },
          } satisfies SoftLawSourceAdapter;

          expect(await run(sourceAdapter)).toEqual({ status: "complete" });
          const before = (
            await db
              .select()
              .from(softLawDocuments)
              .where(eq(softLawDocuments.sourceId, sourceId))
          ).at(0);
          if (!before) {
            panic("WP29 expression placeholder was not stored");
          }

          expect(await run(sourceAdapter)).toEqual({ status: "complete" });
          const after = await db
            .select()
            .from(softLawDocuments)
            .where(eq(softLawDocuments.sourceId, sourceId));
          expect(after).toHaveLength(1);
          expect(after.at(0)?.id).toBe(before.id);
          expect(after.at(0)?.identityKey).toBe(before.identityKey);
          expect(
            await db
              .select()
              .from(softLawDocumentVersions)
              .where(eq(softLawDocumentVersions.documentId, before.id)),
          ).toHaveLength(1);
          expect(
            (
              await db
                .select()
                .from(softLawIngestionAttempts)
                .where(eq(softLawIngestionAttempts.sourceId, sourceId))
            ).some(({ tag }) => tag === "ambiguous_locator"),
          ).toBe(true);
        }),
    );

    test("a numbered WP29 extraction failure cannot be repaired as another document", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        const wpEntry = (reference: string) =>
          ({
            type: "document",
            url: "https://ec.europa.eu/justice/article-29/numbered.doc",
            metadata: {
              title: "Numbered opinion",
              kind: "opinion",
              sourceKind: "Numbered opinion",
              statedReference: { state: "stated", value: reference },
              issuedOn: { state: "not_stated" },
              expression: {
                type: "identified",
                language: "en",
                revision: { state: "not_stated" },
              },
              stage: { state: "not_stated" },
              relations: [],
              validity: {
                state: "not_stated",
                basis: "archived_source_stated",
              },
            },
            sourceDates: {},
          }) as const satisfies SoftLawEntry;
        let current = wpEntry("WP 259");
        let extractionQuality: "extraction_failed" | "text_layer" =
          "extraction_failed";
        const sourceAdapter = {
          ...adapter([current]),
          authority: "eu-wp29",
          discover: async () =>
            Result.ok({ entries: [current], nextCursor: null }),
          fetchDocument: async (item: SoftLawEntry) => {
            const common = {
              metadata: item.metadata,
              raw: [
                {
                  role: "document-word",
                  purpose: "document" as const,
                  bytes: new TextEncoder().encode(item.metadata.title),
                  contentType: "application/msword",
                },
              ],
              sourceDates: {},
            };
            return extractionQuality === "extraction_failed"
              ? Result.ok({
                  ...common,
                  text: null,
                  extractionQuality,
                  extractionFailure: "Binary Word extraction failed",
                })
              : Result.ok({
                  ...common,
                  text: "extracted",
                  extractionQuality,
                });
          },
        } satisfies SoftLawSourceAdapter;

        expect(await run(sourceAdapter)).toEqual({ status: "complete" });
        const before = (
          await db
            .select()
            .from(softLawDocuments)
            .where(eq(softLawDocuments.sourceId, sourceId))
        ).at(0);
        if (!before) {
          panic("Failed numbered WP29 document was not stored");
        }
        current = wpEntry("WP 260");
        extractionQuality = "text_layer";
        expect(await run(sourceAdapter)).toEqual({ status: "complete" });

        const after = await db
          .select()
          .from(softLawDocuments)
          .where(eq(softLawDocuments.sourceId, sourceId));
        expect(after).toHaveLength(1);
        expect(after.at(0)?.id).toBe(before.id);
        expect(after.at(0)?.identityKey).toBe(before.identityKey);
        expect(after.at(0)?.statedReference).toBe("WP 259");
        expect(
          await db
            .select()
            .from(softLawDocumentVersions)
            .where(eq(softLawDocumentVersions.documentId, before.id)),
        ).toHaveLength(1);
        expect(
          (
            await db
              .select()
              .from(softLawIngestionAttempts)
              .where(eq(softLawIngestionAttempts.sourceId, sourceId))
          ).some(({ tag }) => tag === "ambiguous_locator"),
        ).toBe(true);
      }));

    test("a numbered WP29 extraction failure updates when its identity is unchanged", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        const item = {
          type: "document",
          url: "https://ec.europa.eu/justice/article-29/wp259.doc",
          metadata: {
            title: "Numbered opinion",
            kind: "opinion",
            sourceKind: "Numbered opinion",
            statedReference: { state: "stated", value: "WP 259" },
            issuedOn: { state: "not_stated" },
            expression: {
              type: "identified",
              language: "en",
              revision: { state: "not_stated" },
            },
            stage: { state: "not_stated" },
            relations: [],
            validity: {
              state: "not_stated",
              basis: "archived_source_stated",
            },
          },
          sourceDates: {},
        } as const satisfies SoftLawEntry;
        let repaired = false;
        const sourceAdapter = {
          ...adapter([item]),
          authority: "eu-wp29",
          fetchDocument: async () => {
            const common = {
              metadata: item.metadata,
              raw: [
                {
                  role: "document-word",
                  purpose: "document" as const,
                  bytes: new TextEncoder().encode("WP 259"),
                  contentType: "application/msword",
                },
              ],
              sourceDates: {},
            };
            return repaired
              ? Result.ok({
                  ...common,
                  text: "Successfully extracted WP 259",
                  extractionQuality: "text_layer",
                })
              : Result.ok({
                  ...common,
                  text: null,
                  extractionQuality: "extraction_failed",
                  extractionFailure: "Binary Word extraction failed",
                });
          },
        } satisfies SoftLawSourceAdapter;

        expect(await run(sourceAdapter)).toEqual({ status: "complete" });
        const documentId = (
          await db
            .select({ id: softLawDocuments.id })
            .from(softLawDocuments)
            .where(eq(softLawDocuments.sourceId, sourceId))
        ).at(0)?.id;
        if (!documentId) {
          panic("Numbered WP29 document was not stored");
        }
        const originalVersion = (
          await db
            .select()
            .from(softLawDocumentVersions)
            .where(eq(softLawDocumentVersions.documentId, documentId))
        ).at(0);
        if (!originalVersion) {
          panic("Numbered WP29 version was not stored");
        }
        repaired = true;
        expect(await run(sourceAdapter)).toEqual({ status: "complete" });

        const documents = await db
          .select()
          .from(softLawDocuments)
          .where(eq(softLawDocuments.sourceId, sourceId));
        expect(documents).toHaveLength(1);
        expect(documents.at(0)?.id).toBe(documentId);
        const versions = await db
          .select()
          .from(softLawDocumentVersions)
          .where(eq(softLawDocumentVersions.documentId, documentId))
          .orderBy(softLawDocumentVersions.sequence);
        expect(versions).toHaveLength(1);
        expect(versions.at(0)?.id).toBe(originalVersion.id);
        expect(versions.at(0)?.extractedText).toBe(
          "Successfully extracted WP 259",
        );
      }));

    test("a repaired WP29 placeholder merges into the document that owns its recovered identity", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        const metadata = {
          title: "Transparency opinion",
          kind: "opinion",
          sourceKind: "Transparency opinion",
          statedReference: { state: "not_stated" },
          issuedOn: { state: "not_stated" },
          expression: {
            type: "identified",
            language: "en",
            revision: { state: "not_stated" },
          },
          stage: { state: "not_stated" },
          relations: [],
          validity: {
            state: "not_stated",
            basis: "archived_source_stated",
          },
        } as const;
        const archive = {
          type: "document",
          url: "https://ec.europa.eu/justice/article-29/archive.doc",
          metadata,
          sourceDates: {},
        } as const satisfies SoftLawEntry;
        const newsroom = {
          ...archive,
          url: "https://ec.europa.eu/newsroom/article-29/newsroom.doc",
          metadata: {
            ...metadata,
            statedReference: { state: "stated", value: "WP 260" },
          },
        } as const satisfies SoftLawEntry;
        let archiveRepaired = false;
        let failedArchiveFetches = 0;
        const sourceAdapter = (items: readonly SoftLawEntry[]) =>
          ({
            ...adapter(items),
            authority: "eu-wp29",
            fetchDocument: async (item: SoftLawEntry) => {
              if (item.url === archive.url && !archiveRepaired) {
                failedArchiveFetches++;
                return Result.ok({
                  metadata,
                  raw: [
                    {
                      role: "document-word",
                      purpose: "document",
                      bytes: new TextEncoder().encode(
                        `failed archive bytes ${failedArchiveFetches}`,
                      ),
                      contentType: "application/msword",
                    },
                  ],
                  text: null,
                  extractionQuality: "extraction_failed",
                  extractionFailure: "Binary Word extraction failed",
                  sourceDates: {},
                });
              }
              return Result.ok({
                metadata: newsroom.metadata,
                raw: [
                  {
                    role: "document-word",
                    purpose: "document",
                    bytes: new TextEncoder().encode(newsroom.url),
                    contentType: "application/msword",
                  },
                ],
                text: `WP 260 ${newsroom.url}`,
                extractionQuality: "text_layer",
                sourceDates: {},
              });
            },
          }) satisfies SoftLawSourceAdapter;

        expect(await run(sourceAdapter([archive]))).toEqual({
          status: "complete",
        });
        expect(await run(sourceAdapter([archive]))).toEqual({
          status: "complete",
        });
        const placeholderId = (
          await db
            .select({ id: softLawDocuments.id })
            .from(softLawDocuments)
            .where(eq(softLawDocuments.sourceId, sourceId))
        ).at(0)?.id;
        if (!placeholderId) {
          panic("WP29 placeholder was not stored");
        }
        expect(await run(sourceAdapter([newsroom]))).toEqual({
          status: "complete",
        });
        archiveRepaired = true;
        expect(await run(sourceAdapter([archive]))).toEqual({
          status: "complete",
        });

        const documents = await db
          .select()
          .from(softLawDocuments)
          .where(eq(softLawDocuments.sourceId, sourceId));
        expect(documents).toHaveLength(1);
        expect(documents.at(0)?.identityKey).toContain("wp260");
        expect(documents.at(0)?.id).not.toBe(placeholderId);
        const ownerId = documents.at(0)?.id;
        if (!ownerId) {
          panic("Merged WP29 document was not stored");
        }
        const locators = await db
          .select()
          .from(softLawDocumentLocators)
          .where(eq(softLawDocumentLocators.documentId, ownerId));
        expect(locators.map(({ url }) => url).toSorted()).toEqual(
          [archive.url, newsroom.url].toSorted(),
        );
        const versions = await db
          .select()
          .from(softLawDocumentVersions)
          .where(eq(softLawDocumentVersions.documentId, ownerId))
          .orderBy(softLawDocumentVersions.sequence);
        expect(
          versions.map(({ sequence, extractionQuality }) => ({
            sequence,
            extractionQuality,
          })),
        ).toEqual([
          { sequence: 1, extractionQuality: "text_layer" },
          { sequence: 2, extractionQuality: "extraction_failed" },
          { sequence: 3, extractionQuality: "extraction_failed" },
        ]);
        const failedRawKey = rawSourcePayloadKey({
          owner: { family: "soft-law", sourceId },
          data: new TextEncoder().encode("failed archive bytes 1"),
        });
        expect(
          versions.some(({ rawObjects }) =>
            rawObjects.some(({ key }) => key === failedRawKey),
          ),
        ).toBe(true);
        expect(
          (
            await db
              .select()
              .from(softLawIngestionAttempts)
              .where(eq(softLawIngestionAttempts.sourceId, sourceId))
          ).some(({ rawObjects }) =>
            rawObjects.some(({ key }) => key === failedRawKey),
          ),
        ).toBe(true);

        expect(await run(sourceAdapter([archive]))).toEqual({
          status: "complete",
        });
        expect(
          await db
            .select()
            .from(softLawDocumentVersions)
            .where(eq(softLawDocumentVersions.documentId, ownerId)),
        ).toHaveLength(3);
      }));

    test("a repaired WP29 placeholder merges into a same-page new identity owner", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        const unnumberedMetadata = {
          title: "Transparency opinion",
          kind: "opinion",
          sourceKind: "Transparency opinion",
          statedReference: { state: "not_stated" },
          issuedOn: { state: "not_stated" },
          expression: {
            type: "identified",
            language: "en",
            revision: { state: "not_stated" },
          },
          stage: { state: "not_stated" },
          relations: [],
          validity: {
            state: "not_stated",
            basis: "archived_source_stated",
          },
        } as const;
        const numberedMetadata = {
          ...unnumberedMetadata,
          statedReference: { state: "stated", value: "WP 260" },
        } as const;
        const placeholder = {
          type: "document",
          url: "https://ec.europa.eu/justice/article-29/archive.doc",
          metadata: unnumberedMetadata,
          sourceDates: {},
        } as const satisfies SoftLawEntry;
        const numbered = {
          ...placeholder,
          url: "https://ec.europa.eu/newsroom/article-29/wp260.doc",
          metadata: numberedMetadata,
        } as const satisfies SoftLawEntry;
        let repaired = false;
        const sourceAdapter = (items: readonly SoftLawEntry[]) =>
          ({
            ...adapter(items),
            authority: "eu-wp29",
            fetchDocument: async (item: SoftLawEntry) => {
              if (item.url === placeholder.url && !repaired) {
                return Result.ok({
                  metadata: unnumberedMetadata,
                  raw: [
                    {
                      role: "document-word",
                      purpose: "document",
                      bytes: new TextEncoder().encode("failed placeholder"),
                      contentType: "application/msword",
                    },
                  ],
                  text: null,
                  extractionQuality: "extraction_failed",
                  extractionFailure: "Binary Word extraction failed",
                  sourceDates: {},
                });
              }
              return Result.ok({
                metadata: numberedMetadata,
                raw: [
                  {
                    role: "document-word",
                    purpose: "document",
                    bytes: new TextEncoder().encode("WP 260"),
                    contentType: "application/msword",
                  },
                ],
                text: "WP 260 Transparency opinion",
                extractionQuality: "text_layer",
                sourceDates: {},
              });
            },
          }) satisfies SoftLawSourceAdapter;

        expect(await run(sourceAdapter([placeholder]))).toEqual({
          status: "complete",
        });
        const placeholderId = (
          await db
            .select({ id: softLawDocuments.id })
            .from(softLawDocuments)
            .where(eq(softLawDocuments.sourceId, sourceId))
        ).at(0)?.id;
        if (!placeholderId) {
          panic("WP29 placeholder was not stored");
        }
        const placeholderVersion = (
          await db
            .select()
            .from(softLawDocumentVersions)
            .where(eq(softLawDocumentVersions.documentId, placeholderId))
        ).at(0);
        if (!placeholderVersion) {
          panic("WP29 placeholder version was not stored");
        }

        repaired = true;
        expect(await run(sourceAdapter([numbered, placeholder]))).toEqual({
          status: "complete",
        });
        const documents = await db
          .select()
          .from(softLawDocuments)
          .where(eq(softLawDocuments.sourceId, sourceId));
        expect(documents).toHaveLength(1);
        expect(documents.at(0)?.identityKey).toContain("wp260");
        expect(documents.at(0)?.id).not.toBe(placeholderId);
        const ownerId = documents.at(0)?.id;
        if (!ownerId) {
          panic("Same-page WP29 owner was not stored");
        }
        expect(
          (
            await db
              .select({ url: softLawDocumentLocators.url })
              .from(softLawDocumentLocators)
              .where(eq(softLawDocumentLocators.documentId, ownerId))
          ).map(({ url }) => url),
        ).toEqual(expect.arrayContaining([numbered.url, placeholder.url]));
        const versions = await db
          .select()
          .from(softLawDocumentVersions)
          .where(eq(softLawDocumentVersions.documentId, ownerId))
          .orderBy(softLawDocumentVersions.sequence);
        expect(
          versions.map(
            ({
              id,
              sequence,
              metadata,
              extractionQuality,
              observedFrom,
              observedTo,
            }) => ({
              id,
              sequence,
              metadata,
              extractionQuality,
              observedFrom,
              observedTo,
            }),
          ),
        ).toEqual([
          {
            id: placeholderVersion.id,
            sequence: 1,
            metadata: unnumberedMetadata,
            extractionQuality: "extraction_failed",
            observedFrom: placeholderVersion.observedFrom,
            observedTo: expect.any(Date),
          },
          {
            id: expect.any(String),
            sequence: 2,
            metadata: numberedMetadata,
            extractionQuality: "text_layer",
            observedFrom: expect.any(Date),
            observedTo: null,
          },
        ]);
        expect(versions.at(0)?.contentHash).toBe(
          placeholderVersion.contentHash,
        );
        expect(versions.at(1)?.contentHash).not.toBe(
          placeholderVersion.contentHash,
        );

        expect(await run(sourceAdapter([numbered, placeholder]))).toEqual({
          status: "complete",
        });
        expect(
          await db
            .select()
            .from(softLawDocumentVersions)
            .where(eq(softLawDocumentVersions.documentId, ownerId)),
        ).toHaveLength(2);
      }));

    test("page capacity durably defers valid items without consuming their failure budget", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        const entries = ["first", "second", "third"].map((slug) =>
          entry(`https://uoou.gov.cz/${slug}`, slug, slug),
        );
        const bytes = new Uint8Array(40 * 1024 * 1024);
        const calls = new Map<string, number>();
        const sourceAdapter = {
          ...adapter(entries),
          fetchDocument: async (item: SoftLawEntry) => {
            const call = (calls.get(item.url) ?? 0) + 1;
            calls.set(item.url, call);
            if (item.url.endsWith("/third") && (call === 2 || call === 3)) {
              return Result.err(
                new SoftLawAccessError({
                  message: "Temporary publisher failure",
                }),
              );
            }
            return Result.ok({
              ...document(item),
              raw: [
                { role: "document", bytes, contentType: "application/pdf" },
              ],
            });
          },
        } satisfies SoftLawSourceAdapter;
        const receipts = async () =>
          await db
            .select()
            .from(softLawIngestionAttempts)
            .where(eq(softLawIngestionAttempts.sourceId, sourceId));
        expect(await run(sourceAdapter)).toEqual({ status: "paused" });
        expect(calls.get("https://uoou.gov.cz/first")).toBe(1);
        expect(calls.get("https://uoou.gov.cz/second")).toBe(1);
        expect(calls.has("https://uoou.gov.cz/third")).toBe(false);
        expect(
          (await receipts())
            .filter((receipt) => receipt.status === "retryable")
            .map((receipt) => receipt.count),
        ).toEqual([0, 0]);
        expect(await run(sourceAdapter)).toEqual({ status: "paused" });
        expect(calls.get("https://uoou.gov.cz/first")).toBe(1);
        expect(calls.get("https://uoou.gov.cz/second")).toBe(2);
        expect(calls.get("https://uoou.gov.cz/third")).toBe(1);
        expect(
          (await receipts()).find((receipt) => receipt.url.endsWith("/third")),
        ).toMatchObject({ status: "retryable", count: 0 });
        for (const count of [1, 2]) {
          expect(await run(sourceAdapter)).toEqual({ status: "paused" });
          expect(
            (await receipts()).find((receipt) =>
              receipt.url.endsWith("/third"),
            ),
          ).toMatchObject({ status: "retryable", count });
        }
        expect(await run(sourceAdapter)).toEqual({ status: "complete" });
        expect(
          (await receipts()).find((receipt) => receipt.url.endsWith("/third")),
        ).toMatchObject({ status: "applied", count: 3 });
        const documents = await db
          .select()
          .from(softLawDocuments)
          .where(eq(softLawDocuments.sourceId, sourceId));
        expect(documents).toHaveLength(3);
        expect(
          (await receipts()).every((receipt) => receipt.status === "applied"),
        ).toBe(true);
        expect(calls.get("https://uoou.gov.cz/third")).toBe(4);
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
            return Result.ok(
              item.url === oversized.url
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
                : input,
            );
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
                  const response = await fetch("https://uoou.gov.cz/listing");
                  if (Result.isError(response)) {
                    return Result.err(response.error);
                  }
                  return Result.ok({ entries: [], nextCursor: null });
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
        ).toBe("listing_incomplete");
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
        ).toBe("listing_incomplete");
        expect(
          await db
            .select()
            .from(softLawDocuments)
            .where(eq(softLawDocuments.sourceId, sourceId)),
        ).toMatchObject(
          before.map((row) => ({ id: row.id, listingState: "listed" })),
        );
      }));

    test("a thirty-percent removal re-walks from page one and persists new documents without sweeping until acknowledgment", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        const initial = Array.from({ length: 10 }, (_, index) =>
          entry(
            `https://uoou.gov.cz/${index}`,
            `Guidance ${index}`,
            `REF-${index}`,
          ),
        );
        expect(await run(adapter(initial))).toEqual({ status: "complete" });
        const starts: (string | null)[] = [];
        const runIds = new Set<string | null>();
        for (let round = 0; round < 2; round++) {
          const added = entry(
            `https://uoou.gov.cz/new-${round}`,
            `New ${round}`,
            `NEW-${round}`,
          );
          const retained = [...initial.slice(0, 6), added];
          const result = await run({
            ...adapter(retained),
            getTotalCount: async () => ({ type: "count", total: 7 }),
            discover: async ({ cursor }) => {
              if (cursor === null) {
                starts.push(cursor);
              }
              return Result.ok(
                cursor === null
                  ? { entries: retained.slice(0, 4), nextCursor: "second" }
                  : { entries: retained.slice(4), nextCursor: null },
              );
            },
          });
          expect(result).toMatchObject({
            status: "listing_incomplete",
            seen: 7,
            expectedTotal: 7,
          });
          const source = (
            await db
              .select()
              .from(softLawSources)
              .where(eq(softLawSources.id, sourceId))
          ).at(0);
          expect(source).toMatchObject({
            runState: "listing_incomplete",
            failureTag: "listing_incomplete",
            listingSeen: 7,
            listingExpectedTotal: 7,
            syncCursor: null,
            leaseToken: null,
          });
          runIds.add(source?.runId ?? null);
          const rows = await db
            .select()
            .from(softLawDocuments)
            .where(eq(softLawDocuments.sourceId, sourceId));
          expect(rows).toHaveLength(11 + round);
          expect(rows.every((row) => row.listingState === "listed")).toBe(true);
          expect(rows.some((row) => row.title === added.metadata.title)).toBe(
            true,
          );
        }
        expect(starts).toEqual([null, null]);
        expect(runIds.size).toBe(2);
        // Even a full listing cannot silently acknowledge a held removal.
        expect((await run(adapter(initial))).status).toBe("listing_incomplete");
      }));

    test("identical source bytes and metadata keep one version when derived extraction changes", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        const item = entry();
        expect(await run(adapter([item]))).toEqual({ status: "complete" });
        expect(
          await run({
            ...adapter([item]),
            fetchDocument: async () =>
              Result.ok({
                ...document(item),
                text: "improved extraction",
                extractionQuality: "text_layer",
                raw: document(item).raw.map((part) => ({
                  role: part.role,
                  bytes: part.bytes,
                  contentType: "application/pdf",
                })),
              } satisfies SoftLawDocumentInput),
          }),
        ).toEqual({ status: "complete" });
        const versions = await db
          .select({
            text: softLawDocumentVersions.extractedText,
            quality: softLawDocumentVersions.extractionQuality,
          })
          .from(softLawDocumentVersions)
          .innerJoin(
            softLawDocuments,
            eq(softLawDocumentVersions.documentId, softLawDocuments.id),
          )
          .where(eq(softLawDocuments.sourceId, sourceId));
        expect(versions).toEqual([{ text: "original", quality: "html" }]);
      }));

    test("HTML at a requested binary surface is retried then rejected without storing a document", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        const item = entry("https://uoou.gov.cz/media/attachment.pdf");
        let requests = 0;
        const sourceAdapter = {
          ...adapter([item]),
          fetchDocument: async (
            value: SoftLawEntry,
            { fetch }: Parameters<SoftLawSourceAdapter["fetchDocument"]>[1],
          ) => {
            const fetched = await fetch(value.url, {
              expectedContentTypes: ["application/pdf"],
            });
            if (Result.isError(fetched)) {
              return fetched;
            }
            return Result.ok(document(value));
          },
        };
        const request = async () => {
          requests++;
          return new Response("<title>Maintenance</title>", {
            headers: { "content-type": "text/html" },
          });
        };
        for (let round = 0; round < 3; round++) {
          expect(
            (
              await run(sourceAdapter, {
                request,
              })
            ).status,
          ).toBe(round < 2 ? "paused" : "complete");
        }
        expect(requests).toBe(3);
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
              .from(softLawIngestionAttempts)
              .where(eq(softLawIngestionAttempts.sourceId, sourceId))
          ).at(0),
        ).toMatchObject({
          status: "rejected",
          tag: "retry_exhausted",
          count: 3,
        });
      }));

    test("per-document lease renewal completes a page longer than one lease under a simulated clock", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        let elapsedSeconds = 0;
        const items = Array.from({ length: 5 }, (_, index) =>
          entry(
            `https://uoou.gov.cz/${index}`,
            `Guidance ${index}`,
            `REF-${index}`,
          ),
        );
        expect(
          await run({
            ...adapter(items),
            fetchDocument: async (item) => {
              elapsedSeconds += 120;
              // Advance time relative to this lease without sleeping or changing the server clock.
              await db
                .update(softLawSources)
                .set({
                  leaseExpiresAt: sql`${softLawSources.leaseExpiresAt} - interval '120 seconds'`,
                })
                .where(eq(softLawSources.id, sourceId));
              return Result.ok(document(item));
            },
          }),
        ).toEqual({ status: "complete" });
        expect(elapsedSeconds).toBeGreaterThan(300);
        expect(
          await db
            .select()
            .from(softLawDocuments)
            .where(eq(softLawDocuments.sourceId, sourceId)),
        ).toHaveLength(5);
      }));

    test("lease loss between document requests stops access even if the adapter ignores the error", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        let requests = 0;
        const result = await run(
          {
            ...adapter([entry()]),
            fetchDocument: async (item, { fetch }) => {
              await fetch(item.url);
              await db
                .update(softLawSources)
                .set({ leaseToken: createSafeId<"softLawIngestionLease">() })
                .where(eq(softLawSources.id, sourceId));
              const refused = await fetch(item.url);
              expect(Result.isError(refused)).toBe(true);
              return Result.ok(document(item));
            },
          },
          {
            request: async () => {
              requests++;
              return new Response("body");
            },
          },
        );
        expect(result.status).toBe("failed");
        expect(requests).toBe(1);
        expect(
          await db
            .select()
            .from(softLawDocuments)
            .where(eq(softLawDocuments.sourceId, sourceId)),
        ).toHaveLength(0);
      }));

    test("publisher blocks received after a takeover still durably block the source", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        const result = await run(
          {
            ...adapter([entry()]),
            fetchDocument: async (item, { fetch }) => {
              await fetch(item.url);
              return Result.ok(document(item));
            },
          },
          {
            request: async () => {
              await db
                .update(softLawSources)
                .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
                .where(eq(softLawSources.id, sourceId));
              expect(await run(adapter([entry()]))).toEqual({
                status: "complete",
              });
              return new Response("throttled", { status: 429 });
            },
          },
        );
        expect(result).toEqual({ status: "blocked", reason: "rate_limited" });
        expect(
          (
            await db
              .select()
              .from(softLawSources)
              .where(eq(softLawSources.id, sourceId))
          ).at(0),
        ).toMatchObject({
          runState: "blocked",
          failureTag: "rate_limited",
          leaseToken: null,
        });
        expect(await run(adapter([entry()]))).toEqual({
          status: "blocked",
          reason: "rate_limited",
        });
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
              const first = await fetch(item.url);
              const second = await fetch(item.url);
              if (Result.isError(second)) {
                refused++;
              }
              if (mode === "wrapped" && Result.isError(first)) {
                return Result.err(
                  new SoftLawIngestionError({
                    message: "Wrapped publisher failure",
                  }),
                );
              }
              return Result.ok(document(item));
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
            const response = await fetch(entry().url);
            if (Result.isError(response)) {
              return Result.err(response.error);
            }
            return Result.ok({ entries: [], nextCursor: null });
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
        expect((await store.claim()).unwrap().type).toBe("claimed");
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

    test("page persistence stays batched while each additional document renews its lease once", async () => {
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
      expect(calls.at(1)).toBe(
        (calls.at(0) ?? panic("Missing small-page result")) + 7,
      );
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
              const denied = await Result.tryPromise(
                async () =>
                  await db.transaction(async (tx) => {
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
          const denied = await Result.tryPromise(
            async () =>
              await db.transaction(async (tx) => {
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
        const unknownFailure = await Result.tryPromise(
          async () =>
            await db.execute(
              sql`UPDATE soft_law_sources SET failure_tag = 'unknown_failure' WHERE id = ${sourceId}`,
            ),
        );
        expect(Result.isError(unknownFailure)).toBe(true);
      }));

    for (const reverse of [false, true]) {
      for (const separatePages of [false, true]) {
        test(`numbered collision preserves the first observation across pages and replay (reverse=${String(reverse)}, separate=${String(separatePages)})`, async () =>
          await withSource(databaseUrl, async ({ db, sourceId, run }) => {
            const first = entry(
              "https://uoou.gov.cz/numbered-first",
              "Guidance",
              "01/2024",
            );
            const second = entry(
              "https://uoou.gov.cz/numbered-second",
              "Guidance",
              "01/2024",
            );
            const initialOrder = reverse ? [second, first] : [first, second];
            let listed = initialOrder;
            const bodies = new Map([
              [first.url, "first original"],
              [second.url, "second original"],
            ]);
            const winner =
              listed.at(0) ?? panic("Numbered collision fixture is empty");
            const sourceAdapter = {
              ...adapter(listed),
              discover: async ({ cursor }) =>
                Result.ok(
                  separatePages
                    ? {
                        entries:
                          cursor === null
                            ? listed.slice(0, 1)
                            : listed.slice(1),
                        nextCursor: cursor === null ? "second" : null,
                      }
                    : { entries: listed, nextCursor: null },
                ),
              fetchDocument: async (item) =>
                Result.ok(
                  document(
                    item,
                    bodies.get(item.url) ??
                      panic("Unexpected collision locator"),
                  ),
                ),
            } as const satisfies SoftLawSourceAdapter;
            for (let replay = 0; replay < 3; replay++) {
              listed = replay === 1 ? initialOrder.toReversed() : initialOrder;
              expect(await run(sourceAdapter)).toEqual({ status: "complete" });
              const documents = await db
                .select()
                .from(softLawDocuments)
                .where(eq(softLawDocuments.sourceId, sourceId));
              expect(documents).toHaveLength(1);
              const accepted =
                documents.at(0) ?? panic("No accepted numbered document");
              const versions = await db
                .select()
                .from(softLawDocumentVersions)
                .where(eq(softLawDocumentVersions.documentId, accepted.id));
              expect(versions).toHaveLength(1);
              expect(versions.at(0)).toMatchObject({
                sequence: 1,
                extractedText: bodies.get(winner.url),
                observedTo: null,
              });
              const locators = await db
                .select()
                .from(softLawDocumentLocators)
                .where(eq(softLawDocumentLocators.documentId, accepted.id));
              expect(locators).toHaveLength(1);
              expect(locators.at(0)).toMatchObject({
                url: winner.url,
                state: "current",
              });
              const receipts = await db
                .select()
                .from(softLawIngestionAttempts)
                .where(eq(softLawIngestionAttempts.sourceId, sourceId));
              expect(
                receipts.filter(
                  (receipt) => receipt.tag === "identity_collision",
                ),
              ).toHaveLength(replay + 1);
              expect(
                receipts
                  .filter((receipt) => receipt.tag === "identity_collision")
                  .every(
                    (receipt) =>
                      receipt.url !== winner.url &&
                      receipt.identityKey === accepted.identityKey &&
                      receipt.status === "rejected",
                  ),
              ).toBe(true);
            }
          }));
      }
    }

    test("a previous collision can become a numbered move after the winner disappears", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        const winner = entry(
          "https://uoou.gov.cz/winner",
          "Guidance",
          "01/2024",
        );
        const loser = entry("https://uoou.gov.cz/loser", "Guidance", "01/2024");
        const padding = ["03/2024", "04/2024", "05/2024"].map((reference) =>
          entry(
            `https://uoou.gov.cz/${reference}`,
            "Other guidance",
            reference,
          ),
        );
        let listed = [winner, loser, ...padding];
        const sourceAdapter = {
          ...adapter(listed),
          discover: async () =>
            Result.ok({ entries: listed, nextCursor: null }),
          fetchDocument: async (item) => Result.ok(document(item, item.url)),
        } as const satisfies SoftLawSourceAdapter;
        expect(await run(sourceAdapter)).toEqual({ status: "complete" });
        const original =
          (
            await db
              .select()
              .from(softLawDocuments)
              .where(
                and(
                  eq(softLawDocuments.sourceId, sourceId),
                  eq(softLawDocuments.title, winner.metadata.title),
                ),
              )
          ).at(0) ?? panic("Collision winner absent");
        listed = [loser, ...padding];
        expect(await run(sourceAdapter)).toEqual({ status: "complete" });
        const swept = (
          await db
            .select()
            .from(softLawDocuments)
            .where(eq(softLawDocuments.id, original.id))
        ).at(0);
        expect(swept?.listingState).toBe("no_longer_listed");
        expect(await run(sourceAdapter)).toEqual({ status: "complete" });
        const moved = (
          await db
            .select()
            .from(softLawDocuments)
            .where(eq(softLawDocuments.id, original.id))
        ).at(0);
        expect(moved?.listingState).toBe("listed");
        const versions = await db
          .select()
          .from(softLawDocumentVersions)
          .where(eq(softLawDocumentVersions.documentId, original.id))
          .orderBy(softLawDocumentVersions.sequence);
        expect(versions.map((version) => version.extractedText)).toEqual([
          winner.url,
          loser.url,
        ]);
        const locators = await db
          .select()
          .from(softLawDocumentLocators)
          .where(eq(softLawDocumentLocators.documentId, original.id));
        expect(
          locators
            .filter((locator) => locator.state === "current")
            .map((locator) => locator.url),
        ).toEqual([loser.url]);
        const receipts = await db
          .select()
          .from(softLawIngestionAttempts)
          .where(eq(softLawIngestionAttempts.sourceId, sourceId));
        expect(
          receipts.filter((receipt) => receipt.tag === "identity_collision"),
        ).toHaveLength(2);
      }));

    test("collision receipts do not reject a different numbered identity at the same URL", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        const winner = entry(
          "https://uoou.gov.cz/winner",
          "Guidance",
          "01/2024",
        );
        const loser = entry("https://uoou.gov.cz/loser", "Guidance", "01/2024");
        let listed = [winner, loser];
        const sourceAdapter = {
          ...adapter(listed),
          discover: async () =>
            Result.ok({ entries: listed, nextCursor: null }),
          fetchDocument: async (item) => Result.ok(document(item, item.url)),
        } as const satisfies SoftLawSourceAdapter;
        expect(await run(sourceAdapter)).toEqual({ status: "complete" });
        listed = [entry(loser.url, "New guidance", "02/2024"), winner];
        expect(await run(sourceAdapter)).toEqual({ status: "complete" });
        const documents = await db
          .select()
          .from(softLawDocuments)
          .where(eq(softLawDocuments.sourceId, sourceId));
        expect(documents).toHaveLength(2);
        expect(documents.every((item) => item.listingState === "listed")).toBe(
          true,
        );
        const receipts = await db
          .select()
          .from(softLawIngestionAttempts)
          .where(eq(softLawIngestionAttempts.sourceId, sourceId));
        expect(
          receipts.filter((receipt) => receipt.tag === "identity_collision"),
        ).toHaveLength(1);
      }));

    test("a numbered URL move between runs can change content without a collision", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        const original = entry();
        const moved = entry("https://uoou.gov.cz/moved-numbered");
        expect(await run(adapter([original], "original"))).toEqual({
          status: "complete",
        });
        const before =
          (
            await db
              .select()
              .from(softLawDocuments)
              .where(eq(softLawDocuments.sourceId, sourceId))
          ).at(0) ?? panic("Original document absent");
        expect(await run(adapter([moved], "revised"))).toEqual({
          status: "complete",
        });
        const documents = await db
          .select()
          .from(softLawDocuments)
          .where(eq(softLawDocuments.sourceId, sourceId));
        expect(documents).toHaveLength(1);
        expect(documents.at(0)?.id).toBe(before.id);
        const versions = await db
          .select()
          .from(softLawDocumentVersions)
          .where(eq(softLawDocumentVersions.documentId, before.id))
          .orderBy(softLawDocumentVersions.sequence);
        expect(versions.map((version) => version.extractedText)).toEqual([
          "original",
          "revised",
        ]);
        const receipts = await db
          .select()
          .from(softLawIngestionAttempts)
          .where(eq(softLawIngestionAttempts.sourceId, sourceId));
        expect(
          receipts.some((receipt) => receipt.tag === "identity_collision"),
        ).toBe(false);
      }));

    test("undated unnumbered title collisions are rejected and replay cannot churn versions", async () =>
      await assertProperty(
        "undated unnumbered title collisions are rejected and replay cannot churn versions",
        fc.asyncProperty(
          fc
            .string({ minLength: 1, maxLength: 30 })
            .filter((value) => value.trim().length > 0),
          fc.uniqueArray(fc.uuid(), { minLength: 2, maxLength: 2 }),
          async (title, contents) =>
            await withSource(databaseUrl, async ({ db, sourceId, run }) => {
              const items = ["a", "b"].map((slug) => ({
                type: "document" as const,
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
                  Result.ok(
                    document(
                      item,
                      (item.url.endsWith("/a")
                        ? contents.at(0)
                        : contents.at(1)) ?? panic("Generator omitted content"),
                    ),
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
