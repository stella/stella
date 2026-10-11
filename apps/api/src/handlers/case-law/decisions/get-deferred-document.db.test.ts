import { panic } from "better-result";
import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { databaseRelations } from "@/api/db/database-relations";
import {
  caseLawCitations,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import {
  hydrateDeferredDocument,
  decisionDocumentState,
  prepareDecisionDocumentRead,
  STORED_ONLY_DOCUMENT_HYDRATION,
} from "@/api/handlers/case-law/decisions/get-deferred-document";
import { createSafeId } from "@/api/lib/branded-types";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { TEXT_ABSENCE_REASON } from "@/api/lib/case-law/decision-text";
import { withRedistributableSubject } from "@/api/lib/case-law/public-subject";
import type { DecisionSection } from "@/api/lib/legal-search/document-types";
import { metadataMarkedListingOnly } from "@/api/lib/legal-search/partial-observation-sql";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

const INITIAL_DESCRIPTOR = {
  allowsDerivedAi: true,
  allowsRedistribution: true,
  attribution: null,
  license: "permitted-redistribution",
} as const;

const initialSections = [
  {
    index: 0,
    type: "argumentation",
    title: null,
    text: "Stored version of the decision.",
  },
] satisfies DecisionSection[];

const fetchedAst = {
  version: 1,
  source: {
    system: "test",
    documentId: "deferred-document",
    webUrl: "",
    printUrl: "",
  },
  metadata: {
    caseNumber: "deferred-document",
    court: "Court",
    ecli: "",
    decisionDate: "2025-01-01",
    decisionType: "judgment",
    keywords: [],
    statutes: [],
  },
  blocks: [
    {
      id: "fetched-paragraph",
      anchorId: "fetched-p1",
      type: "paragraph",
      inlines: [{ type: "text", text: "Transient fetched decision text." }],
      plainText: "Transient fetched decision text.",
    },
  ],
} satisfies DocumentAst;

test.each([
  "unchanged",
  "derived-AI permission revoked",
  "redistribution permission revoked",
  "publication changed",
  "text revision changed",
  "document URL changed",
] as const)(
  "a deferred document is returned only while its prepared text gate remains valid: %s",
  async (change) => {
    const client = await createTestPglite();
    try {
      const db = drizzle({ client, relations: databaseRelations });
      const readDb = async <T>(
        fn: (tx: CaseLawPublicReadTransaction) => Promise<T>,
      ) =>
        await withPublicLawReaderRole(
          db,
          async (tx) => await fn(asTestRaw<CaseLawPublicReadTransaction>(tx)),
        );
      const caseLawDb = Object.assign(readDb, caseLawPublicReadDb);
      const sourceId = createSafeId<"caseLawSource">();
      const decisionId = createSafeId<"caseLawDecision">();
      const citedDecisionId = createSafeId<"caseLawDecision">();
      const citationId = createSafeId<"caseLawCitation">();
      const storedMetadata = {
        headnote: "Stored publisher headnote.",
        abstract: "Stored publisher abstract.",
      };
      await db.insert(caseLawSources).values(
        caseLawSourceRow({
          adapterKey: "cz-ns",
          descriptor: INITIAL_DESCRIPTOR,
          id: sourceId,
          name: "Deferred test source",
        }),
      );
      await db.insert(caseLawDecisions).values({
        id: decisionId,
        sourceId,
        caseNumber: "deferred-document",
        court: "Court",
        country: "CZE",
        language: "cs",
        documentUrl: "https://example.test/deferred-document",
        metadata: storedMetadata,
        sections: initialSections,
        documentAst: null,
        fulltext: null,
        contentHash: null,
      });
      await db.insert(caseLawDecisions).values({
        id: citedDecisionId,
        sourceId,
        caseNumber: "deferred-document-cited",
        court: "Court",
        country: "CZE",
        language: "cs",
      });
      await db.insert(caseLawCitations).values({
        id: citationId,
        citingDecisionId: decisionId,
        citedDecisionId,
        citationText: "deferred-document-cited",
      });

      const prepared = await withRedistributableSubject(
        caseLawDb,
        { kind: "id", id: decisionId },
        async (subject) => await prepareDecisionDocumentRead({ subject }),
      );
      if (prepared?.type !== "decision") {
        panic("Expected a prepared deferred decision");
      }
      expect(prepared.read.documentPending).toBe(true);

      const hydrated = await hydrateDeferredDocument({
        prepared,
        caseLawDb,
        recordDemand: false,
        documentHydration: STORED_ONLY_DOCUMENT_HYDRATION,
        hydrateDocument: async ({ decision }) => {
          switch (change) {
            case "unchanged":
              break;
            case "derived-AI permission revoked":
              await db
                .update(caseLawSources)
                .set({
                  descriptor: {
                    ...INITIAL_DESCRIPTOR,
                    allowsDerivedAi: false,
                  },
                })
                .where(eq(caseLawSources.id, sourceId));
              break;
            case "redistribution permission revoked":
              await db
                .update(caseLawSources)
                .set({
                  descriptor: {
                    ...INITIAL_DESCRIPTOR,
                    allowsRedistribution: false,
                    license: "restricted",
                  },
                })
                .where(eq(caseLawSources.id, sourceId));
              break;
            case "publication changed":
              await db
                .update(caseLawDecisions)
                .set({
                  metadata: metadataMarkedListingOnly(
                    caseLawDecisions.metadata,
                  ),
                })
                .where(eq(caseLawDecisions.id, decisionId));
              break;
            case "document URL changed":
              await db
                .update(caseLawDecisions)
                .set({ documentUrl: "https://example.test/new-document" })
                .where(eq(caseLawDecisions.id, decisionId));
              break;
            case "text revision changed":
              await db
                .update(caseLawDecisions)
                .set({
                  sections: [
                    {
                      index: 0,
                      type: "argumentation",
                      title: null,
                      text: "A newer stored version of the decision.",
                    },
                  ],
                })
                .where(eq(caseLawDecisions.id, decisionId));
              break;
            default:
              change satisfies never;
          }
          return {
            ...decision,
            documentAst: fetchedAst,
            documentAstSource: null,
            fulltext: null,
            documentPending: false,
            hasDocument: true,
          };
        },
      });

      if (change === "unchanged") {
        expect(hydrated).toMatchObject({
          documentAst: { blocks: [{ id: "fetched-paragraph" }] },
          hasDocument: true,
          documentPending: false,
          metadata: storedMetadata,
          sections: initialSections,
          citationsFrom: [{ id: citationId }],
          source: { allowsDerivedAi: true },
        });
      } else {
        const absenceReason = {
          "derived-AI permission revoked":
            TEXT_ABSENCE_REASON.REDISTRIBUTION_WITHHELD,
          "redistribution permission revoked": TEXT_ABSENCE_REASON.MISSING_TEXT,
          "publication changed": TEXT_ABSENCE_REASON.MISSING_TEXT,
          "text revision changed": TEXT_ABSENCE_REASON.TEXT_CHANGED,
          "document URL changed": TEXT_ABSENCE_REASON.TEXT_CHANGED,
        }[change];
        expect(decisionDocumentState(hydrated, false)).toBe("unavailable");
        expect(hydrated).toMatchObject({
          documentAst: null,
          projectionDigest: null,
          documentAstSource: null,
          fulltext: null,
          sections: null,
          metadata: null,
          headnote: {
            type: "absent",
            reason: absenceReason,
          },
          textFields: {
            abstract: {
              type: "absent",
              reason: absenceReason,
            },
            headnote: {
              type: "absent",
              reason: absenceReason,
            },
            legalSentence: {
              type: "absent",
              reason: absenceReason,
            },
            summary: {
              type: "absent",
              reason: absenceReason,
            },
          },
          textWithheldReason:
            change === "derived-AI permission revoked"
              ? "source_licence"
              : null,
          textIncompleteReason: {
            unchanged: null,
            "derived-AI permission revoked": null,
            "redistribution permission revoked": "missing_text",
            "publication changed": "missing_text",
            "text revision changed": "text_changed",
            "document URL changed": "text_changed",
          }[change],
          citationsFrom: [],
          citationsTo: [],
          documentPending: false,
          documentUnavailable: true,
          hasDocument: false,
          source: {
            allowsDerivedAi:
              change === "text revision changed" ||
              change === "document URL changed",
          },
        });
      }

      const [stored] = await db
        .select({
          contentHash: caseLawDecisions.contentHash,
          documentAst: caseLawDecisions.documentAst,
          sections: caseLawDecisions.sections,
        })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, decisionId));
      expect(stored?.documentAst).toBeNull();
      expect(stored?.contentHash).toBeNull();
      expect(stored?.sections).toEqual(
        change === "text revision changed"
          ? [
              {
                index: 0,
                type: "argumentation",
                title: null,
                text: "A newer stored version of the decision.",
              },
            ]
          : initialSections,
      );
    } finally {
      await client.close();
    }
  },
);
