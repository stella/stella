import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import {
  softLawDocuments,
  softLawDocumentVersions,
  softLawDocumentLocators,
  softLawIngestionAttempts,
} from "@/api/db/schema";
import { rawSourcePayloadKey } from "@/api/lib/legal-search/raw-source-storage";
import type { WriteRawSourcePayload } from "@/api/lib/legal-search/raw-source-storage";
import { SoftLawPageBudgetError } from "@/api/lib/legal-search/soft-law-types";
import type {
  SoftLawEntry,
  SoftLawSourceAdapter,
} from "@/api/lib/legal-search/soft-law-types";
import {
  adapter,
  document,
  entry,
  withSource,
} from "@/api/tests/soft-law-ingestion-support";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !enabled) {
  describe.skip("guidance cache on real Postgres", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS and DATABASE_URL", () => {});
  });
} else {
  describe("guidance cache on real Postgres", () => {
    test("unchanged listing revisions reuse raw objects without fetching; changed or absent revisions fetch again", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        const known = entry();
        const listing = {
          url: known.url,
          metadata: null,
          sourceDates: { "sitemap.lastmod": "2024-08-12T16:35:36+02:00" },
          cacheKey: "revision-1",
        } as const satisfies SoftLawEntry;
        let requests = 0;
        let writes = 0;
        const fetchDocument: SoftLawSourceAdapter["fetchDocument"] = async (
          item,
          { fetch },
        ) => {
          const fetched = await fetch(item.url, { surface: "page" });
          if (fetched.status === "error") {
            return fetched;
          }
          const response = fetched.value;
          return Result.ok({
            ...document(known),
            raw: [
              {
                role: "page",
                bytes: response.bytes,
                contentType: response.contentType,
              },
            ],
            sourceDates: item.sourceDates,
          });
        };
        const dependencies = {
          request: async () => {
            requests++;
            return new Response("source bytes", {
              headers: { "content-type": "text/html" },
            });
          },
          writeRaw: async (options: Parameters<WriteRawSourcePayload>[0]) => {
            writes++;
            return rawSourcePayloadKey(options);
          },
        };
        const runListing = async (item: SoftLawEntry) =>
          await run({ ...adapter([item]), fetchDocument }, dependencies);
        expect(await runListing(listing)).toEqual({ status: "complete" });
        const rawBefore = await db
          .select({ raw: softLawDocumentVersions.rawObjects })
          .from(softLawDocumentVersions)
          .innerJoin(
            softLawDocuments,
            eq(softLawDocumentVersions.documentId, softLawDocuments.id),
          )
          .where(eq(softLawDocuments.sourceId, sourceId));
        expect(await runListing(listing)).toEqual({ status: "complete" });
        expect(requests).toBe(1);
        expect(writes).toBe(1);
        expect(
          await db
            .select({ raw: softLawDocumentVersions.rawObjects })
            .from(softLawDocumentVersions)
            .innerJoin(
              softLawDocuments,
              eq(softLawDocumentVersions.documentId, softLawDocuments.id),
            )
            .where(eq(softLawDocuments.sourceId, sourceId)),
        ).toEqual(rawBefore);
        expect(
          await runListing({
            ...listing,
            cacheKey: "revision-2",
            sourceDates: { "sitemap.lastmod": "2024-08-13T16:35:36+02:00" },
          }),
        ).toEqual({ status: "complete" });
        expect(requests).toBe(2);
        expect(
          await runListing({ url: known.url, metadata: null, sourceDates: {} }),
        ).toEqual({ status: "complete" });
        expect(requests).toBe(3);
        expect(
          await db
            .select()
            .from(softLawDocuments)
            .where(eq(softLawDocuments.sourceId, sourceId)),
        ).toHaveLength(1);
      }));

    test("a historical locator is fetched again when it reappears with the same revision", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        let fetched = 0;
        const known = Array.from({ length: 5 }, (_, index) =>
          entry(
            `https://uoou.gov.cz/${index}`,
            `Guidance ${index}`,
            `REF-${index}`,
          ),
        );
        const listing = known.map((item) => ({
          url: item.url,
          metadata: null,
          sourceDates: {},
          cacheKey: "same",
        }));
        const sourceAdapter = {
          ...adapter(listing),
          fetchDocument: async (item: SoftLawEntry) => {
            fetched++;
            return Result.ok(
              document(
                known.find((value) => value.url === item.url) ??
                  panic("Unexpected locator"),
              ),
            );
          },
        };
        expect(await run(sourceAdapter)).toEqual({ status: "complete" });
        expect(
          await run({
            ...sourceAdapter,
            discover: async () =>
              Result.ok({
                entries: listing.slice(1),
                nextCursor: null,
              }),
          }),
        ).toEqual({ status: "complete" });
        expect(fetched).toBe(5);
        expect(await run(sourceAdapter)).toEqual({ status: "complete" });
        expect(fetched).toBe(6);
        const rows = await db
          .select()
          .from(softLawDocuments)
          .where(eq(softLawDocuments.sourceId, sourceId));
        expect(rows).toHaveLength(5);
        expect(rows.every((row) => row.listingState === "listed")).toBe(true);
      }));

    test("a matching listing revision is fetched again when its cached hash differs from the current version", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        const known = entry();
        const listing = {
          url: known.url,
          metadata: null,
          sourceDates: {},
          cacheKey: "unchanged-revision",
        } as const satisfies SoftLawEntry;
        let fetched = 0;
        const sourceAdapter = {
          ...adapter([listing]),
          fetchDocument: async () => {
            fetched++;
            return Result.ok(document(known));
          },
        };
        expect(await run(sourceAdapter)).toEqual({ status: "complete" });
        await db
          .update(softLawDocumentLocators)
          .set({ cacheContentHash: "0".repeat(64) })
          .where(eq(softLawDocumentLocators.sourceId, sourceId));
        expect(await run(sourceAdapter)).toEqual({ status: "complete" });
        expect(fetched).toBe(2);
        const versions = await db
          .select({ hash: softLawDocumentVersions.contentHash })
          .from(softLawDocumentVersions)
          .innerJoin(
            softLawDocuments,
            eq(softLawDocumentVersions.documentId, softLawDocuments.id),
          )
          .where(eq(softLawDocuments.sourceId, sourceId));
        expect(versions).toHaveLength(1);
        const locators = await db
          .select({ hash: softLawDocumentLocators.cacheContentHash })
          .from(softLawDocumentLocators)
          .where(eq(softLawDocumentLocators.sourceId, sourceId));
        expect(locators).toEqual(versions);
      }));

    test("a cached winner on a later page defeats a deferred candidate without fetching the winner again", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        const original = entry(
          "https://uoou.gov.cz/original",
          "Original guidance",
          "02/2024",
        );
        const candidate = entry(
          "https://uoou.gov.cz/candidate",
          "Changed guidance",
          "02/2024",
        );
        const cachedWinner = {
          url: original.url,
          metadata: null,
          sourceDates: {},
          cacheKey: "stable-parser-and-revision",
        } as const satisfies SoftLawEntry;
        const calls = { winner: 0, candidate: 0, raw: 0 };
        const fetchDocument: SoftLawSourceAdapter["fetchDocument"] = async (
          item,
        ) => {
          if (item.url === original.url) {
            calls.winner++;
            return Result.ok(document(original, "Original source bytes"));
          }
          calls.candidate++;
          return Result.ok(document(candidate, "Changed candidate bytes"));
        };
        const writeRaw: WriteRawSourcePayload = async (options) => {
          calls.raw++;
          return rawSourcePayloadKey(options);
        };
        expect(
          await run(
            { ...adapter([cachedWinner]), fetchDocument },
            { writeRaw },
          ),
        ).toEqual({ status: "complete" });
        const before = await db
          .select()
          .from(softLawDocuments)
          .where(eq(softLawDocuments.sourceId, sourceId));
        const originalDocument = before.at(0) ?? panic("Cached winner missing");
        const versionsBefore = await db
          .select()
          .from(softLawDocumentVersions)
          .where(eq(softLawDocumentVersions.documentId, originalDocument.id));
        const sourceAdapter = {
          ...adapter([candidate, cachedWinner]),
          discover: async ({ cursor }) => {
            if (cursor === null) {
              return Result.ok({
                entries: [candidate],
                nextCursor: "cached-winner",
              });
            }
            const pending = await db
              .select()
              .from(softLawIngestionAttempts)
              .where(eq(softLawIngestionAttempts.sourceId, sourceId));
            expect(
              pending.find((attempt) => attempt.url === candidate.url),
            ).toMatchObject({ status: "deferred", tag: null });
            return Result.ok({ entries: [cachedWinner], nextCursor: null });
          },
          fetchDocument,
        } as const satisfies SoftLawSourceAdapter;
        expect(await run(sourceAdapter, { writeRaw })).toEqual({
          status: "complete",
        });
        expect(calls).toEqual({ winner: 1, candidate: 1, raw: 2 });
        const after = await db
          .select()
          .from(softLawDocuments)
          .where(eq(softLawDocuments.sourceId, sourceId));
        expect(after).toHaveLength(1);
        expect(after.at(0)).toMatchObject({
          id: originalDocument.id,
          title: original.metadata.title,
          listingState: "listed",
        });
        expect(
          await db
            .select()
            .from(softLawDocumentVersions)
            .where(eq(softLawDocumentVersions.documentId, originalDocument.id)),
        ).toEqual(versionsBefore);
        const locators = await db
          .select()
          .from(softLawDocumentLocators)
          .where(eq(softLawDocumentLocators.sourceId, sourceId));
        expect(locators).toHaveLength(1);
        expect(locators.at(0)).toMatchObject({
          url: original.url,
          state: "current",
          cacheKey: cachedWinner.cacheKey,
        });
        const attempts = await db
          .select()
          .from(softLawIngestionAttempts)
          .where(eq(softLawIngestionAttempts.sourceId, sourceId));
        expect(
          attempts.find((attempt) => attempt.url === candidate.url),
        ).toMatchObject({
          status: "rejected",
          tag: "identity_collision",
          count: 1,
        });
        expect(attempts.some((attempt) => attempt.status === "deferred")).toBe(
          false,
        );
      }));

    test("remaining page byte exhaustion pauses and retries the valid document with a fresh budget", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        const first = entry(
          "https://uoou.gov.cz/first",
          "First guidance",
          "FIRST",
        );
        const second = entry(
          "https://uoou.gov.cz/second",
          "Second guidance",
          "SECOND",
        );
        const fullBudget = 64 * 1024 * 1024;
        const secondBudgets: number[] = [];
        let firstCalls = 0;
        const sourceAdapter = {
          ...adapter([first, second]),
          fetchDocument: async (item, { maxRawBytes }) => {
            if (item.url === first.url) {
              firstCalls++;
              return Result.ok(document(item, "first"));
            }
            secondBudgets.push(maxRawBytes);
            if (maxRawBytes < fullBudget) {
              return Result.err(
                new SoftLawPageBudgetError({
                  message: "Valid document needs a fresh page budget",
                }),
              );
            }
            return Result.ok(document(item, "second"));
          },
        } as const satisfies SoftLawSourceAdapter;
        expect(await run(sourceAdapter)).toEqual({ status: "paused" });
        const pending = await db
          .select()
          .from(softLawIngestionAttempts)
          .where(eq(softLawIngestionAttempts.sourceId, sourceId));
        expect(
          pending.find((attempt) => attempt.url === second.url),
        ).toMatchObject({ status: "retryable", tag: null });
        expect(
          pending.some((attempt) => attempt.tag === "invalid_document"),
        ).toBe(false);
        expect(
          await db
            .select()
            .from(softLawDocuments)
            .where(eq(softLawDocuments.sourceId, sourceId)),
        ).toHaveLength(1);
        expect(await run(sourceAdapter)).toEqual({ status: "complete" });
        expect(firstCalls).toBe(1);
        expect(secondBudgets).toEqual([
          fullBudget - new TextEncoder().encode("first").byteLength,
          fullBudget,
        ]);
        const settled = await db
          .select()
          .from(softLawIngestionAttempts)
          .where(eq(softLawIngestionAttempts.sourceId, sourceId));
        expect(
          settled.find((attempt) => attempt.url === second.url),
        ).toMatchObject({ status: "applied", tag: null });
        expect(
          settled.some((attempt) => attempt.tag === "invalid_document"),
        ).toBe(false);
        expect(
          await db
            .select()
            .from(softLawDocuments)
            .where(eq(softLawDocuments.sourceId, sourceId)),
        ).toHaveLength(2);
      }));

    test("excluded publisher material is recorded as a terminal reason and does not stall later guidance", async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        const excluded = entry(
          "https://uoou.gov.cz/excluded",
          "Translation",
          "EXCLUDED",
        );
        const accepted = entry("https://uoou.gov.cz/accepted");
        const result = await run({
          ...adapter([excluded, accepted]),
          fetchDocument: async (item) =>
            item.url === excluded.url
              ? Result.ok({ type: "excluded", reason: "edpb_translation" })
              : Result.ok(document(item)),
        });
        expect(result).toEqual({ status: "complete" });
        expect(
          (
            await db
              .select()
              .from(softLawDocuments)
              .where(eq(softLawDocuments.sourceId, sourceId))
          ).map((row) => row.title),
        ).toEqual([accepted.metadata.title]);
        expect(
          (
            await db
              .select()
              .from(softLawIngestionAttempts)
              .where(eq(softLawIngestionAttempts.sourceId, sourceId))
          ).find((row) => row.url === excluded.url),
        ).toMatchObject({ status: "rejected", tag: "edpb_translation" });
      }));
  });
}
