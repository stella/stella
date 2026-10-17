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

const checkDeferredRead = async (
  change: "unchanged" | "publication changed" | "completion read failed",
) => {
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
      "pages",
      { kind: "id", id: decisionId },
      async (subject) => await prepareDecisionDocumentRead({ subject }),
    );
    if (prepared?.type !== "decision") {
      panic("Expected a prepared deferred decision");
    }
    expect(prepared.read.documentPending).toBe(true);

    const hydrated = await hydrateDeferredDocument({
      prepared,
      caseLawDb:
        change === "completion read failed"
          ? Object.assign(
              async <T>(
                _fn: (tx: CaseLawPublicReadTransaction) => Promise<T>,
              ) =>
                await Promise.reject(
                  new TypeError("Synthetic completion query failure"),
                ),
              caseLawPublicReadDb,
            )
          : caseLawDb,
      recordDemand: false,
      documentHydration: STORED_ONLY_DOCUMENT_HYDRATION,
      hydrateDocument: async ({ decision }) => {
        if (change === "publication changed") {
          await db
            .update(caseLawDecisions)
            .set({
              metadata: metadataMarkedListingOnly(caseLawDecisions.metadata),
            })
            .where(eq(caseLawDecisions.id, decisionId));
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
        metadata: {},
        textFields: {
          abstract: { type: "present", text: storedMetadata.abstract },
          headnote: { type: "present", text: storedMetadata.headnote },
        },
        sections: initialSections,
        citationsFrom: [{ id: citationId }],
        source: { allowsDerivedAi: true },
      });
    } else {
      const absenceReason = TEXT_ABSENCE_REASON.MISSING_TEXT;
      expect(decisionDocumentState(hydrated, false)).toBe("unavailable");
      expect(hydrated).toMatchObject({
        id: decisionId,
        caseNumber: "deferred-document",
        textIncompleteReason:
          change === "completion read failed" ? "gate_failed" : "missing_text",
        textWithheldReason: null,
        documentAst: null,
        projectionDigest: null,
        documentAstSource: null,
        fulltext: null,
        sections: null,
        metadata: {},
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
        citationsFrom: [],
        citationsTo: [],
        documentPending: false,
        documentUnavailable: true,
        hasDocument: false,
        source: { allowsDerivedAi: false },
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
    expect(stored?.sections).toEqual(initialSections);
  } finally {
    await client.close();
  }
};

test("a deferred document remains transient when completion is unchanged", async () => {
  await checkDeferredRead("unchanged");
});

test("a deferred document is withheld when publication changes during hydration", async () => {
  await checkDeferredRead("publication changed");
});

test("a completion read failure returns decision metadata with gate_failed", async () => {
  await checkDeferredRead("completion read failed");
});
