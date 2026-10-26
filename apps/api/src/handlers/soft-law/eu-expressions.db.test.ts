import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { Buffer } from "node:buffer";

import { stellaPublicLawReader } from "@/api/db/rls";
import {
  softLawDocumentLocators,
  softLawDocuments,
  softLawDocumentVersions,
  softLawIngestionAttempts,
  softLawSources,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { rawSourcePayloadKey } from "@/api/lib/legal-search/raw-source-storage";
import type {
  SoftLawEntry,
  SoftLawExtractionQuality,
  SoftLawSourceAdapter,
} from "@/api/lib/legal-search/soft-law-types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

import { runSoftLawIngestion } from "./ingestion";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const compareCanonicalStrings = (left: string, right: string) => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};
const evidence = {
  url: "https://www.edpb.europa.eu/guidelines/example",
  quote: "Version adopted",
  locator: "heading",
};
type EntryOptions = {
  language: string;
  revision: string;
  stage: "consultation" | "adopted";
};
const entry = ({ language, revision, stage }: EntryOptions): SoftLawEntry => ({
  type: "document",
  url: `https://www.edpb.europa.eu/guidelines/example/${language}/${revision}`,
  metadata: {
    title: "Guidelines on processing",
    kind: "guideline",
    sourceKind: "Guidelines",
    statedReference: { state: "stated", value: "01/2024" },
    issuedOn: { state: "stated", value: "2024-01-16" },
    expression: {
      type: "identified",
      language,
      revision: { state: "stated", value: revision },
    },
    stage: { state: stage, evidence },
    relations: [],
    validity: { state: "not_stated", basis: "source_stated" },
  },
  sourceRaw: [
    {
      role: "index",
      contentBase64: Buffer.from("Publisher index snapshot 1").toBase64(),
      contentType: "text/html",
    },
  ],
  sourceDates: {},
});
type ExtractionState =
  | {
      extractionQuality: "extraction_failed";
      text: null;
      extractionFailure: string;
    }
  | {
      extractionQuality: Exclude<SoftLawExtractionQuality, "extraction_failed">;
      text: string | null;
      extractionFailure?: never;
    };
const DEFAULT_EXTRACTION = {
  extractionQuality: "html",
  text: "Unchanged publisher bytes",
} as const satisfies ExtractionState;
const adapter = (
  entries: readonly SoftLawEntry[],
  extraction?: ExtractionState | ((item: SoftLawEntry) => ExtractionState),
) =>
  ({
    key: "eu-expression-test",
    authority: "eu-edpb",
    access: {
      publisherGate: "edpb-eu",
      userAgent: "Stella/1.0 (+https://stella.example/contact)",
      window: { type: "any_time" },
    },
    discover: async () => Result.ok({ entries, nextCursor: null }),
    fetchDocument: async (item) => {
      const extractionState =
        typeof extraction === "function"
          ? extraction(item)
          : (extraction ?? DEFAULT_EXTRACTION);
      return Result.ok({
        metadata: item.metadata,
        raw: [
          ...(item.sourceRaw ?? []).map(
            ({ role, contentBase64, contentType }) => ({
              role,
              bytes: Buffer.from(contentBase64, "base64"),
              contentType,
              purpose: "discovery" as const,
            }),
          ),
          {
            role: "document",
            purpose: "document",
            bytes: new TextEncoder().encode("Unchanged publisher bytes"),
            contentType: "text/html",
          },
        ],
        ...extractionState,
        sourceDates: item.sourceDates,
      });
    },
    getTotalCount: async () => ({ type: "no-count-endpoint" }),
    sliceWalk: { type: "unsupported", reason: "Complete fixture listing" },
    sourceFields: {
      status: "declared",
      fields: {},
      listSourceFields: () => [],
    },
    sourceSurfaces: { surfaces: {} },
  }) as const satisfies SoftLawSourceAdapter;

if (!databaseUrl || !enabled) {
  describe.skip("EU soft-law expression persistence", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS and DATABASE_URL", () => {});
  });
} else {
  describe("EU soft-law expression persistence", () => {
    test("unchanged documents retain the strongest successful extraction without adding history", async () =>
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 3 });
        const sourceId = createSafeId<"softLawSource">();
        const adapterKey = `eu-extraction-rank-test-${sourceId}`;
        const entries = [
          entry({ language: "en", revision: "1.0", stage: "adopted" }),
          entry({ language: "cs", revision: "1.0", stage: "adopted" }),
          entry({ language: "de", revision: "1.0", stage: "adopted" }),
          entry({ language: "fr", revision: "1.0", stage: "adopted" }),
        ];
        await db.insert(softLawSources).values({
          id: sourceId,
          adapterKey,
          descriptor: {
            license: "public-domain",
            attribution: null,
            allowsRedistribution: true,
            allowsDerivedAi: true,
          },
        });
        const run = async (
          extractions: Readonly<Record<string, ExtractionState>>,
        ) =>
          await runSoftLawIngestion({
            sourceId,
            adapter: {
              ...adapter(
                entries,
                (item) =>
                  extractions[
                    item.metadata.expression?.type === "identified"
                      ? item.metadata.expression.language
                      : ""
                  ] ?? panic("Extraction fixture absent"),
              ),
              key: adapterKey,
            },
            scopedDb: async (work) => await db.transaction(work),
            signal: new AbortController().signal,
            writeRaw: async (options) => rawSourcePayloadKey(options),
            accessDependencies: { reserve: async () => {} },
          });
        const versions = async () =>
          await db
            .select({
              metadata: softLawDocumentVersions.metadata,
              extractionQuality: softLawDocumentVersions.extractionQuality,
              extractedText: softLawDocumentVersions.extractedText,
              extractionFailure: softLawDocumentVersions.extractionFailure,
            })
            .from(softLawDocumentVersions)
            .innerJoin(
              softLawDocuments,
              eq(softLawDocumentVersions.documentId, softLawDocuments.id),
            )
            .where(eq(softLawDocuments.sourceId, sourceId));
        try {
          expect(
            await run({
              en: { extractionQuality: "text_layer", text: "Layer text" },
              cs: { extractionQuality: "needs_ocr", text: null },
              de: {
                extractionQuality: "extraction_failed",
                text: null,
                extractionFailure: "Initial extraction failure",
              },
              fr: { extractionQuality: "html", text: "HTML text" },
            }),
          ).toEqual({ status: "complete" });
          expect(
            await run({
              en: { extractionQuality: "needs_ocr", text: null },
              cs: { extractionQuality: "text_layer", text: "Vrstva textu" },
              de: { extractionQuality: "html", text: "HTML-Text" },
              fr: {
                extractionQuality: "extraction_failed",
                text: null,
                extractionFailure: "Transient extraction failure",
              },
            }),
          ).toEqual({ status: "complete" });

          const rows = await versions();
          expect(rows).toHaveLength(4);
          const byLanguage = new Map(
            rows.map((row) => [
              row.metadata.expression?.type === "identified"
                ? row.metadata.expression.language
                : panic("Expression language absent"),
              row,
            ]),
          );
          expect(byLanguage.get("en")).toMatchObject({
            extractionQuality: "text_layer",
            extractedText: "Layer text",
            extractionFailure: null,
          });
          expect(byLanguage.get("cs")).toMatchObject({
            extractionQuality: "text_layer",
            extractedText: "Vrstva textu",
            extractionFailure: null,
          });
          expect(byLanguage.get("de")).toMatchObject({
            extractionQuality: "html",
            extractedText: "HTML-Text",
            extractionFailure: null,
          });
          expect(byLanguage.get("fr")).toMatchObject({
            extractionQuality: "html",
            extractedText: "HTML text",
            extractionFailure: null,
          });
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
          await db
            .delete(softLawSources)
            .where(eq(softLawSources.id, sourceId));
        }
      }));

    test("languages and revisions coexist while lifecycle updates preserve expression history and replay reaches a fixed point", async () =>
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 3 });
        const sourceId = createSafeId<"softLawSource">();
        const adapterKey = `eu-expression-test-${sourceId}`;
        await db.insert(softLawSources).values({
          id: sourceId,
          adapterKey,
          descriptor: {
            license: "public-domain",
            attribution: null,
            allowsRedistribution: true,
            allowsDerivedAi: true,
          },
        });
        const run = async (
          entries: readonly SoftLawEntry[],
          extraction?: ExtractionState,
        ) =>
          await runSoftLawIngestion({
            sourceId,
            adapter: { ...adapter(entries, extraction), key: adapterKey },
            scopedDb: async (work) => await db.transaction(work),
            signal: new AbortController().signal,
            writeRaw: async (options) => rawSourcePayloadKey(options),
            accessDependencies: { reserve: async () => {} },
          });
        const documents = async () =>
          await db
            .select()
            .from(softLawDocuments)
            .where(eq(softLawDocuments.sourceId, sourceId));
        const versions = async () =>
          await db
            .select({
              id: softLawDocumentVersions.id,
              documentId: softLawDocumentVersions.documentId,
              metadata: softLawDocumentVersions.metadata,
              sequence: softLawDocumentVersions.sequence,
              observedTo: softLawDocumentVersions.observedTo,
              contentHash: softLawDocumentVersions.contentHash,
              extractionQuality: softLawDocumentVersions.extractionQuality,
              extractedText: softLawDocumentVersions.extractedText,
              extractionFailure: softLawDocumentVersions.extractionFailure,
            })
            .from(softLawDocumentVersions)
            .innerJoin(
              softLawDocuments,
              eq(softLawDocumentVersions.documentId, softLawDocuments.id),
            )
            .where(eq(softLawDocuments.sourceId, sourceId));
        try {
          const draft = entry({
            language: "en",
            revision: "1.0",
            stage: "consultation",
          });
          const others = [
            entry({ language: "cs", revision: "1.0", stage: "adopted" }),
            entry({ language: "en", revision: "2.0", stage: "adopted" }),
          ];
          expect(
            await run([draft, ...others], {
              extractionQuality: "extraction_failed",
              text: null,
              extractionFailure: "Publisher text extraction failed",
            }),
          ).toEqual({ status: "complete" });
          const failedVersions = await versions();
          expect(failedVersions).toHaveLength(3);
          for (const version of failedVersions) {
            expect(version).toMatchObject({
              extractionQuality: "extraction_failed",
              extractedText: null,
              extractionFailure: "Publisher text extraction failed",
            });
          }
          // A textless parse of the same bytes is a better extraction than a
          // failure: it upgrades the quality and clears the stale failure.
          expect(
            await run([draft, ...others], {
              extractionQuality: "needs_ocr",
              text: null,
            }),
          ).toEqual({ status: "complete" });
          for (const version of await versions()) {
            expect(version).toMatchObject({
              extractionQuality: "needs_ocr",
              extractedText: null,
              extractionFailure: null,
            });
          }
          expect(await run([draft, ...others])).toEqual({ status: "complete" });
          const repairedVersions = await versions();
          expect(
            repairedVersions
              .map((version) => ({
                id: version.id,
                contentHash: version.contentHash,
              }))
              .toSorted((left, right) =>
                compareCanonicalStrings(left.id, right.id),
              ),
          ).toEqual(
            failedVersions
              .map((version) => ({
                id: version.id,
                contentHash: version.contentHash,
              }))
              .toSorted((left, right) =>
                compareCanonicalStrings(left.id, right.id),
              ),
          );
          for (const version of repairedVersions) {
            expect(version).toMatchObject({
              extractionQuality: "html",
              extractedText: "Unchanged publisher bytes",
              extractionFailure: null,
            });
          }
          expect(
            await run([draft, ...others], {
              extractionQuality: "extraction_failed",
              text: null,
              extractionFailure: "Transient extraction failure",
            }),
          ).toEqual({ status: "complete" });
          for (const version of await versions()) {
            expect(version).toMatchObject({
              extractionQuality: "html",
              extractedText: "Unchanged publisher bytes",
              extractionFailure: null,
            });
          }
          const initial = await documents();
          expect(initial).toHaveLength(3);
          expect(new Set(initial.map((row) => row.identityKey)).size).toBe(3);
          const originalVersions = await versions();
          const draftVersion =
            originalVersions.find(
              (row) => row.metadata.stage?.state === "consultation",
            ) ?? panic("Draft expression absent");
          const adopted = {
            ...draft,
            metadata: {
              ...draft.metadata,
              stage: { state: "adopted", evidence },
            },
          } as const;
          expect(await run([adopted, ...others])).toEqual({
            status: "complete",
          });
          const afterAdoption = await versions();
          expect((await documents()).map((row) => row.id).toSorted()).toEqual(
            initial.map((row) => row.id).toSorted(),
          );
          const history = afterAdoption
            .filter((row) => row.documentId === draftVersion.documentId)
            .toSorted((a, b) => a.sequence - b.sequence);
          expect(history.map((row) => row.metadata.stage?.state)).toEqual([
            "consultation",
            "adopted",
          ]);
          expect(history.at(0)?.observedTo).not.toBeNull();
          expect(history.at(1)?.observedTo).toBeNull();
          expect(history.at(0)?.contentHash).not.toBe(
            history.at(1)?.contentHash,
          );
          expect(afterAdoption).toHaveLength(4);
          const fixedPoint = afterAdoption.map((row) => row.id).toSorted();
          for (let replay = 0; replay < 2; replay++) {
            expect(await run([adopted, ...others].toReversed())).toEqual({
              status: "complete",
            });
            expect((await versions()).map((row) => row.id).toSorted()).toEqual(
              fixedPoint,
            );
          }
          const current = (await versions()).filter(
            (row) => row.observedTo === null,
          );
          expect(current).toHaveLength(3);
          expect(
            current.every(
              (row) =>
                row.metadata.stage?.state === "adopted" &&
                row.metadata.relations?.length === 0,
            ),
          ).toBe(true);
          expect(
            current
              .map((row) => row.metadata.expression)
              .toSorted((a, b) =>
                compareCanonicalStrings(JSON.stringify(a), JSON.stringify(b)),
              ),
          ).toEqual(
            [adopted, ...others]
              .map((item) => item.metadata.expression)
              .toSorted((a, b) =>
                compareCanonicalStrings(JSON.stringify(a), JSON.stringify(b)),
              ),
          );
          const superseded = {
            ...adopted,
            metadata: {
              ...adopted.metadata,
              validity: { state: "superseded", basis: "source_stated" },
              relations: [
                { type: "superseded_by", reference: "02/2024", evidence },
              ],
            },
          } as const satisfies SoftLawEntry;
          expect(await run([superseded, ...others])).toEqual({
            status: "complete",
          });
          const supersededHistory = (await versions())
            .filter((row) => row.documentId === draftVersion.documentId)
            .toSorted((a, b) => a.sequence - b.sequence);
          expect(supersededHistory).toHaveLength(3);
          expect(supersededHistory.at(-1)?.metadata).toEqual(
            superseded.metadata,
          );
          expect(
            (await documents()).find(
              (row) => row.id === draftVersion.documentId,
            )?.validityState,
          ).toBe("superseded");
          expect(await run([superseded, ...others])).toEqual({
            status: "complete",
          });
          expect(await versions()).toHaveLength(5);
          const beforeRefresh = await db
            .select()
            .from(softLawIngestionAttempts)
            .where(eq(softLawIngestionAttempts.sourceId, sourceId));
          const originalIndexKeys = new Set(
            beforeRefresh.flatMap((receipt) =>
              receipt.rawObjects
                .filter((raw) => raw.role === "index")
                .map((raw) => raw.key),
            ),
          );
          expect(originalIndexKeys.size).toBe(1);
          const refreshedEntries = [superseded, ...others].map((item) => ({
            ...item,
            sourceRaw: [
              {
                role: "index",
                contentBase64: Buffer.from(
                  "Publisher index snapshot 2",
                ).toBase64(),
                contentType: "text/html",
              },
            ],
          }));
          expect(await run(refreshedEntries)).toEqual({ status: "complete" });
          expect(await versions()).toHaveLength(5);
          const afterRefresh = await db
            .select()
            .from(softLawIngestionAttempts)
            .where(eq(softLawIngestionAttempts.sourceId, sourceId));
          const initialReceiptIds = new Set(
            beforeRefresh.map((receipt) => receipt.id),
          );
          const refreshedReceipts = afterRefresh.filter(
            (receipt) => !initialReceiptIds.has(receipt.id),
          );
          expect(refreshedReceipts).toHaveLength(3);
          for (const receipt of refreshedReceipts) {
            expect(receipt.status).toBe("unchanged");
            expect(
              receipt.rawObjects.map((raw) => raw.role).toSorted(),
            ).toEqual(["document", "index"]);
            const indexObject =
              receipt.rawObjects.find((raw) => raw.role === "index") ??
              panic("Refreshed receipt lacks source index");
            expect(originalIndexKeys.has(indexObject.key)).toBe(false);
          }
          for (const receipt of afterRefresh) {
            expect(receipt.entry.sourceRaw).toBeUndefined();
          }
          const locators = await db
            .select()
            .from(softLawDocumentLocators)
            .innerJoin(
              softLawDocuments,
              eq(softLawDocumentLocators.documentId, softLawDocuments.id),
            )
            .where(eq(softLawDocuments.sourceId, sourceId));
          expect(locators).toHaveLength(3);
          for (const role of ["stella", stellaPublicLawReader.name]) {
            const read = await Result.tryPromise(
              async () =>
                await db.transaction(async (tx) => {
                  await tx.execute(sql.raw(`SET LOCAL ROLE "${role}"`));
                  return await tx
                    .select()
                    .from(softLawDocuments)
                    .where(eq(softLawDocuments.sourceId, sourceId));
                }),
            );
            if (!Result.isError(read)) {
              panic("Public role could read non-public EU soft law");
            }
            let cause: unknown = read.error.cause;
            let denied = false;
            for (
              let depth = 0;
              depth < 8 && typeof cause === "object" && cause !== null;
              depth++
            ) {
              if (
                ("code" in cause && cause.code === "42501") ||
                (cause instanceof Error &&
                  cause.message.includes("permission denied"))
              ) {
                denied = true;
                break;
              }
              cause = "cause" in cause ? cause.cause : null;
            }
            expect(denied).toBe(true);
          }
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
          await db
            .delete(softLawSources)
            .where(eq(softLawSources.id, sourceId));
        }
      }));
  });
}
