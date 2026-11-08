import { describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import { stellaIngestion, stellaPublicLawReader } from "@/api/db/rls";
import type { Transaction } from "@/api/db/root";
import {
  softLawDocumentLocators,
  softLawDocuments,
  softLawDocumentVersions,
  softLawSources,
  systemAuditRuns,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { recordSystemAudit } from "@/api/lib/system-audit/record";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

import {
  readSoftLawDocument,
  searchSoftLawDocuments,
  SOFT_LAW_DOCUMENT_CLASS,
  SOFT_LAW_TEXT_STATE,
} from "./soft-law-read";
import { SOFT_LAW_READ_SURFACE } from "./soft-law-serving";
import type { SoftLawMetadata } from "./soft-law-types";

type ReaderTransaction = Pick<Transaction, "execute" | "select">;

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const NOW = new Date("2026-11-08T12:00:00.000Z");
const metadataOf = (title: string): SoftLawMetadata => ({
  title,
  kind: "guideline",
  statedReference: { state: "not_stated" },
  issuedOn: { state: "stated", value: "2025-03-01" },
  expression: {
    type: "identified",
    language: "en",
    revision: { state: "not_stated" },
  },
  validity: { state: "not_stated", basis: "source_stated" },
});

type Fixture = {
  authority: string;
  kind: "guideline" | "inspection_report" | "methodology";
  title: string;
  text: string;
};

const FIXTURES = {
  edpb: {
    authority: "eu-edpb",
    kind: "guideline",
    title: "Guidelines on zqxconsent handling",
    text: "The controller should document zqxbody processing.",
  },
  uoouMethodology: {
    authority: "cz-uoou",
    kind: "methodology",
    title: "Metodika zpracování zqxconsent",
    text: "Správce eviduje zqxbody zpracování.",
  },
  uoouInspection: {
    authority: "cz-uoou",
    kind: "inspection_report",
    title: "Kontrola zqxconsent",
    text: "Kontrolovaná osoba zqxbody.",
  },
  wp29: {
    authority: "eu-wp29",
    kind: "guideline",
    title: "Working party zqxconsent opinion",
    text: "Unserved zqxbody.",
  },
  unknown: {
    authority: "zz-unknown",
    kind: "guideline",
    title: "Stray zqxconsent row",
    text: "Stray zqxbody.",
  },
} as const satisfies Record<string, Fixture>;

const documentId = () => createSafeId<"softLawDocument">();
const FIXTURE_KEYS = [
  "edpb",
  "uoouMethodology",
  "uoouInspection",
  "wp29",
  "unknown",
] as const;

describe.skipIf(!enabled || databaseUrl === undefined)(
  "soft-law read path under the reader role",
  () => {
    const openFixtures = async (
      fn: (context: {
        ids: Readonly<
          Record<(typeof FIXTURE_KEYS)[number], ReturnType<typeof documentId>>
        >;
        asReader: <T>(
          work: (tx: ReaderTransaction) => Promise<T>,
        ) => Promise<T>;
      }) => Promise<void>,
    ) =>
      await withGatedTestClients(databaseUrl ?? "", async ({ openClient }) => {
        const { db } = openClient({ max: 2 });
        const sourceId = createSafeId<"softLawSource">();
        const runId = createSafeId<"systemScriptRun">();
        const ids = {
          edpb: documentId(),
          uoouMethodology: documentId(),
          uoouInspection: documentId(),
          wp29: documentId(),
          unknown: documentId(),
        };
        await db.insert(softLawSources).values({
          id: sourceId,
          adapterKey: `soft-law-read-${sourceId}`,
          descriptor: {
            license: "public-domain",
            attribution: null,
            allowsRedistribution: false,
            allowsDerivedAi: false,
          },
        });
        for (const key of FIXTURE_KEYS) {
          const fixture = FIXTURES[key];
          const id = ids[key];
          await db.insert(softLawDocuments).values({
            id,
            sourceId,
            identityKey: key,
            jurisdiction: "EU",
            authority: fixture.authority,
            kind: fixture.kind,
            title: fixture.title,
            statedReferenceState: "not_stated",
            issuedOn: "2025-03-01",
            issuedOnState: "stated",
            listingState: "listed",
            validityState: "not_stated",
            validityBasis: "source_stated",
            firstSeenAt: NOW,
            lastSeenAt: NOW,
            lastSeenRun: runId,
          });
          await db.insert(softLawDocumentVersions).values({
            id: createSafeId<"softLawDocumentVersion">(),
            documentId: id,
            sequence: 1,
            contentHash: `hash-${key}`,
            rawObjects: [],
            metadata: metadataOf(fixture.title),
            extractedText: fixture.text,
            extractionQuality: "html",
            sourceDates: {},
            observedFrom: NOW,
          });
          await db.insert(softLawDocumentLocators).values({
            id: createSafeId<"softLawDocumentLocator">(),
            sourceId,
            documentId: id,
            url: `https://publisher.example/${sourceId}/${key}`,
            firstSeenAt: NOW,
            lastSeenAt: NOW,
            lastSeenRun: runId,
            state: "current",
          });
        }
        try {
          await fn({
            ids,
            asReader: async (work) =>
              await db.transaction(async (tx) => {
                await tx.execute(
                  sql.raw(`SET LOCAL ROLE "${stellaPublicLawReader.name}"`),
                );
                return await work(tx);
              }),
          });
        } finally {
          const documentIds = Object.values(ids);
          await db
            .delete(softLawDocumentLocators)
            .where(inArray(softLawDocumentLocators.documentId, documentIds));
          await db
            .delete(softLawDocumentVersions)
            .where(inArray(softLawDocumentVersions.documentId, documentIds));
          await db
            .delete(softLawDocuments)
            .where(eq(softLawDocuments.sourceId, sourceId));
          await db
            .delete(softLawSources)
            .where(eq(softLawSources.id, sourceId));
        }
      });

    test("the reader role neither bypasses row security nor is superuser", async () => {
      await openFixtures(async ({ asReader }) => {
        const flags = await asReader(
          async (tx) =>
            await tx.execute(
              sql`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`,
            ),
        );
        expect([...flags]).toEqual([{ rolbypassrls: false, rolsuper: false }]);
      });
    });

    test("search returns served rows only, labelled as guidance", async () => {
      await openFixtures(async ({ asReader, ids }) => {
        const page = await asReader(
          async (tx) =>
            await searchSoftLawDocuments(tx, {
              query: "zqxconsent",
              surface: SOFT_LAW_READ_SURFACE.mcp,
              limit: 20,
              offset: 0,
            }),
        );
        expect(page.items.map(({ documentId: id }) => id).toSorted()).toEqual(
          [ids.edpb, ids.uoouMethodology].toSorted(),
        );
        for (const item of page.items) {
          expect(item.documentClass).toBe(SOFT_LAW_DOCUMENT_CLASS);
          expect(item.publisherUrl).toStartWith("https://publisher.example/");
          expect(item.attribution.text).not.toBe("");
        }
      });
    });

    test("body text matches for a served source, folded for diacritics", async () => {
      await openFixtures(async ({ asReader, ids }) => {
        const page = await asReader(
          async (tx) =>
            await searchSoftLawDocuments(tx, {
              query: "zpracovani zqxbody",
              surface: SOFT_LAW_READ_SURFACE.people,
              authority: "cz-uoou",
              limit: 20,
              offset: 0,
            }),
        );
        expect(page.items.map(({ documentId: id }) => id)).toEqual([
          ids.uoouMethodology,
        ]);
      });
    });

    test("a read returns text, and hides a withheld kind and an unserved source", async () => {
      await openFixtures(async ({ asReader, ids }) => {
        const read = async (id: (typeof ids)["edpb"]) =>
          await asReader(
            async (tx) =>
              await readSoftLawDocument(tx, {
                documentId: id,
                surface: SOFT_LAW_READ_SURFACE.mcp,
              }),
          );
        expect(await read(ids.edpb)).toMatchObject({
          access: "text",
          textState: SOFT_LAW_TEXT_STATE.available,
          text: FIXTURES.edpb.text,
          attribution: {
            termsUrl: "https://www.edpb.europa.eu/copyright_en",
          },
        });
        expect(await read(ids.uoouInspection)).toBeNull();
        expect(await read(ids.wp29)).toBeNull();
        expect(await read(ids.unknown)).toBeNull();
      });
    });

    test("the ingestion role can register a source and audit it", async () => {
      await withGatedTestClients(databaseUrl ?? "", async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        const id = createSafeId<"softLawSource">();
        const subject = createSafeId<"systemScriptRun">();
        await db.transaction(async (tx) => {
          await tx.execute(sql.raw(`SET LOCAL ROLE "${stellaIngestion.name}"`));
          await tx.insert(softLawSources).values({
            id,
            adapterKey: `soft-law-register-${id}`,
            descriptor: {
              license: "public-domain",
              attribution: null,
              allowsRedistribution: false,
              allowsDerivedAi: false,
            },
          });
          await recordSystemAudit(tx, "system:eu-soft-law-ingestion", {
            subject,
            counts: { sourcesRegistered: 1 },
          });
        });
        await db.delete(softLawSources).where(eq(softLawSources.id, id));
        await db
          .delete(systemAuditRuns)
          .where(eq(systemAuditRuns.subject, subject));
      });
    });
  },
);
