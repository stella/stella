import { afterAll, beforeAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";

import type { PublicCountrySurface } from "@stll/api-contract/public-country-capability";

import {
  caseLawCitations,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import {
  listDecisionCitationsHandler,
  listLeadingCitationsHandler,
  listTopCitingDecisionsHandler,
  summarizeDecisionCitationsHandler,
} from "@/api/handlers/case-law/decisions/citation-graph";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import {
  listIncomingDecisionCitations,
  listOutgoingDecisionCitations,
} from "@/api/lib/case-law/decision-citations";
import { withRedistributableSubject } from "@/api/lib/case-law/public-subject";
import type {
  CaseLawSurfaceCountries,
  RedistributableDecisionSubject,
} from "@/api/lib/case-law/public-subject";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

/**
 * A pages-public country is open on identity reads and decision pages, and
 * closed on search. The gate is handed an explicit table so every read reached
 * from a gated subject must answer to the subject's own surface: the gate itself, the
 * citation graph (list, summary, leaders, top citers) and the reader's
 * citation pages.
 */
const PAGES_ONLY_COUNTRY = "SVK";
const SURFACE_COUNTRIES: CaseLawSurfaceCountries = {
  identity: ["CZE", PAGES_ONLY_COUNTRY],
  pages: ["CZE", PAGES_ONLY_COUNTRY],
  search: ["CZE"],
};

const sourceId = createSafeId<"caseLawSource">();
const admittedSubjectId = createSafeId<"caseLawDecision">();
const pagesOnlyRelatedId = createSafeId<"caseLawDecision">();
const admittedRelatedId = createSafeId<"caseLawDecision">();

const citationId = (value: number): SafeId<"caseLawCitation"> =>
  toSafeId<"caseLawCitation">(
    `00000000-0000-7000-8000-${String(value).padStart(12, "0")}`,
  );

/** Ids and texts are ASCII fixture keys, so code-unit order is the order. */
const byCodeUnit = (left: string, right: string) => {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};

let client: Awaited<ReturnType<typeof createTestPglite>>;
let caseLawDb: CaseLawPublicReadDb;

beforeAll(
  async () => {
    client = await createTestPglite();
    const db = drizzle({ client });
    const readDb = async <T>(
      fn: (tx: CaseLawPublicReadTransaction) => Promise<T>,
    ) =>
      await withPublicLawReaderRole(
        db,
        async (tx) =>
          // SAFETY: the role transaction has the same Drizzle read surface as
          // the public-law handle; writes remain on the owner database above.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- PGlite test transaction stands in for the public read handle
          await fn(tx as unknown as CaseLawPublicReadTransaction),
      );
    // SAFETY: brand-only wrapper; the reads never inspect the marker.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the branded handle carries no behaviour
    caseLawDb = readDb as unknown as CaseLawPublicReadDb;

    await db
      .insert(caseLawSources)
      .values(
        caseLawSourceRow({ adapterKey: "open", id: sourceId, name: "open" }),
      );
    await db.insert(caseLawDecisions).values([
      {
        caseNumber: "admitted-subject",
        country: "CZE",
        court: "Court",
        id: admittedSubjectId,
        language: "cs",
        slug: "admitted-subject",
        sourceId,
      },
      {
        caseNumber: "pages-only-related",
        citationAuthority: 9,
        country: PAGES_ONLY_COUNTRY,
        court: "Court",
        id: pagesOnlyRelatedId,
        language: "sk",
        slug: "pages-only-related",
        sourceId,
      },
      {
        caseNumber: "admitted-related",
        citationAuthority: 1,
        country: "CZE",
        court: "Court",
        id: admittedRelatedId,
        language: "cs",
        slug: "admitted-related",
        sourceId,
      },
    ]);
    await db.insert(caseLawCitations).values([
      {
        citedDecisionId: pagesOnlyRelatedId,
        citingDecisionId: admittedSubjectId,
        citationText: "cites-pages-only",
        id: citationId(1),
      },
      {
        citedDecisionId: admittedSubjectId,
        citingDecisionId: pagesOnlyRelatedId,
        citationText: "cited-by-pages-only",
        id: citationId(2),
      },
      {
        citedDecisionId: admittedRelatedId,
        citingDecisionId: admittedSubjectId,
        citationText: "cites-admitted",
        id: citationId(3),
      },
      {
        citedDecisionId: admittedSubjectId,
        citingDecisionId: admittedRelatedId,
        citationText: "cited-by-admitted",
        id: citationId(4),
      },
    ]);
  },
  { timeout: 120_000 },
);

afterAll(async () => {
  await client.close();
});

const onSurface = async <T>(
  surface: PublicCountrySurface,
  id: SafeId<"caseLawDecision">,
  read: (subject: RedistributableDecisionSubject) => Promise<T>,
) =>
  await withRedistributableSubject(
    caseLawDb,
    { surface, surfaceCountries: SURFACE_COUNTRIES },
    { kind: "id", id },
    read,
  );

const relatedIds = (
  page: Awaited<ReturnType<typeof listDecisionCitationsHandler>> | null,
) => {
  if (page === null || !("items" in page)) {
    throw new Error("expected a citation page");
  }
  return page.items
    .flatMap((item) =>
      item.decision === null ? [] : [String(item.decision.id)],
    )
    .toSorted(byCodeUnit);
};

test("the gate admits a pages-public decision on identity and pages but not search", async () => {
  expect(
    await onSurface("identity", pagesOnlyRelatedId, async ({ id }) => id),
  ).toBe(pagesOnlyRelatedId);
  expect(
    await onSurface("pages", pagesOnlyRelatedId, async ({ id }) => id),
  ).toBe(pagesOnlyRelatedId);
  expect(
    await onSurface("search", pagesOnlyRelatedId, async ({ id }) => id),
  ).toBeNull();
});

test("an admitted subject's graph shows a pages-public decision on pages and omits it on search", async () => {
  for (const direction of ["incoming", "outgoing"] as const) {
    const list = async (surface: PublicCountrySurface) =>
      relatedIds(
        await onSurface(
          surface,
          admittedSubjectId,
          async (subject) =>
            await listDecisionCitationsHandler({
              subject,
              query: { direction },
            }),
        ),
      );
    expect(await list("pages")).toEqual(
      [String(admittedRelatedId), String(pagesOnlyRelatedId)].toSorted(
        byCodeUnit,
      ),
    );
    expect(await list("search")).toEqual([String(admittedRelatedId)]);
  }

  const leaders = async (surface: PublicCountrySurface) =>
    (
      (
        await onSurface(
          surface,
          admittedSubjectId,
          async (subject) =>
            await listLeadingCitationsHandler({
              subject,
              query: { direction: "incoming" },
            }),
        )
      )?.items ?? []
    ).map((item) => String(item.decision.id));
  expect(await leaders("pages")).toContain(String(pagesOnlyRelatedId));
  expect(await leaders("search")).toEqual([String(admittedRelatedId)]);

  const topCiting = async (surface: PublicCountrySurface) =>
    await onSurface(surface, admittedSubjectId, async (subject) => {
      const summary = await summarizeDecisionCitationsHandler({
        subject,
        currentYear: 2026,
      });
      if (!("incoming" in summary)) {
        throw new Error("expected a citation summary");
      }
      const incomingTotal = Object.values(summary.incoming).reduce(
        (total, count) => total + count,
        0,
      );
      const top = await listTopCitingDecisionsHandler({
        subject,
        summary,
        limit: 5,
      });
      return {
        incomingTotal,
        ids: top.items.map((item) => String(item.id)),
      };
    });
  expect(await topCiting("pages")).toEqual({
    incomingTotal: 2,
    ids: [String(pagesOnlyRelatedId), String(admittedRelatedId)],
  });
  expect(await topCiting("search")).toEqual({
    incomingTotal: 1,
    ids: [String(admittedRelatedId)],
  });
});

test("the reader's citation pages answer to the subject's surface", async () => {
  const read = async (surface: PublicCountrySurface) =>
    await onSurface(surface, admittedSubjectId, async (subject) => {
      const options = {
        tx: subject.tx,
        cursor: undefined,
        decisionId: subject.id,
        countries: subject.countries,
      };
      const [outgoing, incoming] = await Promise.all([
        listOutgoingDecisionCitations(options),
        listIncomingDecisionCitations(options),
      ]);
      if (!("items" in outgoing) || !("items" in incoming)) {
        throw new Error("expected citation pages");
      }
      return {
        outgoing: outgoing.items
          .map((item) => item.citationText)
          .toSorted(byCodeUnit),
        incoming: incoming.items
          .map((item) => item.citationText)
          .toSorted(byCodeUnit),
      };
    });
  expect(await read("pages")).toEqual({
    outgoing: ["cites-admitted", "cites-pages-only"],
    incoming: ["cited-by-admitted", "cited-by-pages-only"],
  });
  expect(await read("search")).toEqual({
    outgoing: ["cites-admitted"],
    incoming: ["cited-by-admitted"],
  });
});
