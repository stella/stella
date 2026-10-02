import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import {
  softLawDocuments,
  softLawDocumentVersions,
  softLawSources,
} from "@/api/db/schema";
import { RAW_SOURCE_FAMILY } from "@/api/lib/legal-search/raw-source-family";
import { rawSourcePayloadKey } from "@/api/lib/legal-search/raw-source-storage";
import {
  softLawContentHash,
  softLawIdentityKey,
} from "@/api/lib/legal-search/soft-law-fingerprint";
import { createSoftLawIngestionStore } from "@/api/lib/legal-search/soft-law-ingestion-store";
import type {
  SoftLawDocumentInput,
  SoftLawMetadata,
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
  describe.skip("guidance history hardening on real Postgres", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS and DATABASE_URL", () => {});
  });
} else {
  test("equal reference identities in simultaneously retained sources remain independent", async () =>
    await withSource(
      databaseUrl,
      async (first) =>
        await withSource(databaseUrl, async (second) => {
          const original = entry("https://uoou.gov.cz/first-source");
          const other = entry(
            "https://uoou.gov.cz/second-source",
            "Other title",
          );
          expect(await first.run(adapter([original], "first bytes"))).toEqual({
            status: "complete",
          });
          const before = await first.db
            .select()
            .from(softLawDocuments)
            .where(eq(softLawDocuments.sourceId, first.sourceId));
          const firstDocument = before.at(0) ?? panic("First source absent");
          const history = await first.db
            .select()
            .from(softLawDocumentVersions)
            .where(eq(softLawDocumentVersions.documentId, firstDocument.id));
          expect(await second.run(adapter([other], "second bytes"))).toEqual({
            status: "complete",
          });
          const after = await first.db
            .select()
            .from(softLawDocuments)
            .where(eq(softLawDocuments.sourceId, first.sourceId));
          expect(after).toEqual(before);
          expect(
            await first.db
              .select()
              .from(softLawDocumentVersions)
              .where(eq(softLawDocumentVersions.documentId, firstDocument.id)),
          ).toEqual(history);
          const secondDocuments = await second.db
            .select()
            .from(softLawDocuments)
            .where(eq(softLawDocuments.sourceId, second.sourceId));
          expect(secondDocuments).toHaveLength(1);
          const secondDocument =
            secondDocuments.at(0) ?? panic("Second source absent");
          expect(secondDocument.id).not.toBe(firstDocument.id);
          expect(secondDocument.identityKey).toBe(firstDocument.identityKey);
          expect(secondDocument.sourceId).toBe(second.sourceId);
          const secondVersions = await second.db
            .select()
            .from(softLawDocumentVersions)
            .where(eq(softLawDocumentVersions.documentId, secondDocument.id));
          expect(secondVersions).toHaveLength(1);
          expect(secondVersions.at(0)?.extractedText).toBe("second bytes");
        }),
    ));

  test("raw storage receives every binary byte and independently addressed part", async () =>
    await withSource(databaseUrl, async ({ db, sourceId, run }) => {
      const item = entry();
      const raw = [
        {
          role: "page",
          bytes: new Uint8Array([0, 255, 128, 13, 10]),
          contentType: "text/html",
        },
        {
          role: "attachment",
          bytes: new Uint8Array([254, 0, 1, 192, 255]),
          contentType: "application/pdf",
        },
      ] as const satisfies SoftLawDocumentInput["raw"];
      expect(raw[0].bytes).not.toEqual(raw[1].bytes);
      const captured: Uint8Array[] = [];
      const sourceAdapter = {
        ...adapter([item]),
        fetchDocument: async () => Result.ok({ ...document(item), raw }),
      } as const satisfies SoftLawSourceAdapter;
      expect(
        await run(sourceAdapter, {
          writeRaw: async (options) => {
            expect(typeof options.data).not.toBe("string");
            if (typeof options.data === "string") {
              panic("Binary payload became text");
            }
            captured.push(new Uint8Array(options.data));
            return rawSourcePayloadKey(options);
          },
        }),
      ).toEqual({ status: "complete" });
      expect(captured).toEqual(raw.map((part) => part.bytes));
      const documents = await db
        .select()
        .from(softLawDocuments)
        .where(eq(softLawDocuments.sourceId, sourceId));
      const stored = documents.at(0) ?? panic("Binary document absent");
      const versions = await db
        .select()
        .from(softLawDocumentVersions)
        .where(eq(softLawDocumentVersions.documentId, stored.id));
      expect(versions).toHaveLength(1);
      const expected = raw.map((part) => ({
        role: part.role,
        key: rawSourcePayloadKey({
          owner: { family: RAW_SOURCE_FAMILY.SOFT_LAW, sourceId },
          data: part.bytes,
        }),
        contentType: part.contentType,
      }));
      expect(expected.at(0)?.key).not.toBe(expected.at(1)?.key);
      expect(versions.at(0)?.rawObjects).toEqual(expected);
    }));

  for (const change of [
    "attachment bytes",
    "attachment added",
    "attachment removed",
    "attachment role",
  ] as const) {
    test(`isolated ${change} creates immutable version history`, async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        const item = entry();
        const page = {
          role: "page",
          bytes: new Uint8Array([11, 12]),
          contentType: "text/html",
        };
        const attachment = {
          role: "attachment",
          bytes: new Uint8Array([21, 22]),
          contentType: "application/pdf",
        };
        const initial: SoftLawDocumentInput = {
          ...document(item),
          raw: change === "attachment added" ? [page] : [page, attachment],
        };
        const changed: SoftLawDocumentInput = {
          ...initial,
          raw:
            change === "attachment removed"
              ? [page]
              : [
                  page,
                  {
                    ...attachment,
                    role:
                      change === "attachment role"
                        ? "renamed attachment"
                        : attachment.role,
                    bytes:
                      change === "attachment bytes"
                        ? new Uint8Array([21, 23])
                        : attachment.bytes,
                  },
                ],
        };
        expect(initial.raw.at(0)?.bytes).toEqual(changed.raw.at(0)?.bytes);
        expect(softLawContentHash(changed)).not.toBe(
          softLawContentHash(initial),
        );
        let input = initial;
        const sourceAdapter = {
          ...adapter([item]),
          fetchDocument: async () => Result.ok(input),
        } as const satisfies SoftLawSourceAdapter;
        expect(await run(sourceAdapter)).toEqual({ status: "complete" });
        const documents = await db
          .select()
          .from(softLawDocuments)
          .where(eq(softLawDocuments.sourceId, sourceId));
        const stored =
          documents.at(0) ?? panic("Raw dependency document absent");
        const before = await db
          .select()
          .from(softLawDocumentVersions)
          .where(eq(softLawDocumentVersions.documentId, stored.id));
        expect(before).toHaveLength(1);
        input = changed;
        expect(await run(sourceAdapter)).toEqual({ status: "complete" });
        const after = await db
          .select()
          .from(softLawDocumentVersions)
          .where(eq(softLawDocumentVersions.documentId, stored.id))
          .orderBy(softLawDocumentVersions.sequence);
        expect(after.map((version) => version.sequence)).toEqual([1, 2]);
        expect(after.at(0)).toEqual({
          ...before.at(0),
          observedTo: after.at(1)?.observedFrom,
        });
        expect(after.at(1)?.contentHash).toBe(softLawContentHash(changed));
        expect(after.at(1)?.observedTo).toBeNull();
        expect(
          after.filter((version) => version.observedTo === null),
        ).toHaveLength(1);
        expect(await run(sourceAdapter)).toEqual({ status: "complete" });
        expect(
          await db
            .select()
            .from(softLawDocumentVersions)
            .where(eq(softLawDocumentVersions.documentId, stored.id))
            .orderBy(softLawDocumentVersions.sequence),
        ).toEqual(after);
      }));
  }

  const changes = {
    title: { title: "Revised title" },
    kind: { kind: "methodology" },
    issuedOn: { issuedOn: { state: "stated", value: "2024-03-01" } },
    validityBasis: {
      validity: { state: "not_stated", basis: "archived_source_stated" },
    },
  } as const satisfies Record<string, Partial<SoftLawMetadata>>;
  for (const [field, delta] of Object.entries(changes)) {
    test(`numbered metadata ${field} changes append history and refresh the projection`, async () =>
      await withSource(databaseUrl, async ({ db, sourceId, run }) => {
        const item = entry();
        const initial = document(item);
        const changed = {
          ...initial,
          metadata: { ...initial.metadata, ...delta },
        };
        expect(changed.raw).toEqual(initial.raw);
        expect(softLawIdentityKey("cz-uoou", changed.metadata).unwrap()).toBe(
          softLawIdentityKey("cz-uoou", initial.metadata).unwrap(),
        );
        expect(softLawContentHash(changed)).not.toBe(
          softLawContentHash(initial),
        );
        let input = initial;
        const sourceAdapter = {
          ...adapter([item]),
          fetchDocument: async () => Result.ok(input),
        } as const satisfies SoftLawSourceAdapter;
        expect(await run(sourceAdapter)).toEqual({ status: "complete" });
        input = changed;
        expect(await run(sourceAdapter)).toEqual({ status: "complete" });
        const documents = await db
          .select()
          .from(softLawDocuments)
          .where(eq(softLawDocuments.sourceId, sourceId));
        expect(documents).toHaveLength(1);
        const stored = documents.at(0) ?? panic("Metadata document absent");
        expect(stored).toMatchObject({
          title: changed.metadata.title,
          kind: changed.metadata.kind,
          issuedOnState: changed.metadata.issuedOn.state,
          issuedOn:
            changed.metadata.issuedOn.state === "stated"
              ? changed.metadata.issuedOn.value
              : null,
          validityState: changed.metadata.validity.state,
          validityBasis: changed.metadata.validity.basis,
        });
        const versions = await db
          .select()
          .from(softLawDocumentVersions)
          .where(eq(softLawDocumentVersions.documentId, stored.id))
          .orderBy(softLawDocumentVersions.sequence);
        expect(versions.map((version) => version.sequence)).toEqual([1, 2]);
        expect(versions.at(0)?.metadata).toEqual(initial.metadata);
        expect(versions.at(1)?.metadata).toEqual(changed.metadata);
        expect(versions.at(0)?.rawObjects).toEqual(versions.at(1)?.rawObjects);
        expect(versions.at(0)?.observedTo).toEqual(
          versions.at(1)?.observedFrom,
        );
        expect(
          versions.filter((version) => version.observedTo === null),
        ).toHaveLength(1);
      }));
  }

  test("fetched metadata controls identity and projection when the listing teaser differs", async () =>
    await withSource(databaseUrl, async ({ db, sourceId, run }) => {
      const listing = entry();
      const authoritative = {
        ...listing.metadata,
        title: "Authoritative title",
        statedReference: { state: "stated", value: "03/2024" },
        issuedOn: { state: "stated", value: "2024-04-01" },
      } as const satisfies SoftLawMetadata;
      const input = { ...document(listing), metadata: authoritative };
      const sourceAdapter = {
        ...adapter([listing]),
        fetchDocument: async () => Result.ok(input),
      } as const satisfies SoftLawSourceAdapter;
      expect(await run(sourceAdapter)).toEqual({ status: "complete" });
      const documents = await db
        .select()
        .from(softLawDocuments)
        .where(eq(softLawDocuments.sourceId, sourceId));
      expect(documents).toHaveLength(1);
      const stored = documents.at(0) ?? panic("Authoritative document absent");
      expect(stored.identityKey).toBe(
        softLawIdentityKey("cz-uoou", authoritative).unwrap(),
      );
      expect(stored.identityKey).not.toBe(
        softLawIdentityKey("cz-uoou", listing.metadata).unwrap(),
      );
      expect(stored).toMatchObject({
        title: authoritative.title,
        statedReference: "03/2024",
        issuedOn: "2024-04-01",
      });
      const versions = await db
        .select()
        .from(softLawDocumentVersions)
        .where(eq(softLawDocumentVersions.documentId, stored.id));
      expect(versions.at(0)?.metadata).toEqual(authoritative);
    }));

  test("an expired lease cannot be renewed even when its token has not been replaced", async () =>
    await withSource(databaseUrl, async ({ db, sourceId }) => {
      const sourceAdapter = {
        ...adapter([entry()]),
        key: `soft-law-test-${sourceId}`,
      };
      const first = createSoftLawIngestionStore({
        sourceId,
        adapter: sourceAdapter,
        scopedDb: async (work) => await db.transaction(work),
      });
      expect((await first.claim()).unwrap().type).toBe("claimed");
      const before =
        (
          await db
            .select()
            .from(softLawSources)
            .where(eq(softLawSources.id, sourceId))
        ).at(0) ?? panic("Claimed source absent");
      await db
        .update(softLawSources)
        .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
        .where(eq(softLawSources.id, sourceId));
      const renewed = await first.renew();
      expect(renewed.status).toBe("error");
      if (renewed.status !== "error") {
        panic("Expired lease was renewed");
      }
      expect(renewed.error.message).toBe("Ingestion lease was superseded");
      const after =
        (
          await db
            .select()
            .from(softLawSources)
            .where(eq(softLawSources.id, sourceId))
        ).at(0) ?? panic("Expired source absent");
      expect(after.leaseToken).toBe(before.leaseToken);
      expect(after.leaseExpiresAt?.getTime()).toBeLessThan(Date.now());
      const replacement = createSoftLawIngestionStore({
        sourceId,
        adapter: sourceAdapter,
        scopedDb: async (work) => await db.transaction(work),
      });
      expect((await replacement.claim()).unwrap().type).toBe("claimed");
    }));
}
