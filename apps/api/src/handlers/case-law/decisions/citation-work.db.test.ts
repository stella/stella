/**
 * Citations belong to the judgment, not to one language version's row.
 *
 * The fixture is a judgment held in three languages whose edges sit on
 * different versions, as resolution leaves them: a citing judgment's Czech
 * version cites the Czech version and its German version the German one, and
 * only two versions carry outgoing rows, one of them repeating the other's
 * references. Every citation read must answer the same for each version, and
 * count each citation once. A decision that is its work's only version, and
 * two same-language decisions an ECLI-less docket groups together, must read
 * as they always did.
 */
import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import {
  caseLawCitations,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { recomputeCitationAuthorityBatch } from "@/api/handlers/case-law/citation-authority";
import { CITATION_KIND } from "@/api/handlers/case-law/citation-kind";
import {
  listDecisionCitationsHandler,
  listLeadingCitationsHandler,
  listTopCitingDecisionsHandler,
  summarizeDecisionCitationsHandler,
} from "@/api/handlers/case-law/decisions/citation-graph";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import type { CitationDirection } from "@/api/lib/case-law/citation-vocabulary";
import {
  listIncomingDecisionCitations,
  listOutgoingDecisionCitations,
} from "@/api/lib/case-law/decision-citations";
import { readDecisionWork } from "@/api/lib/case-law/decision-work";
import { withRedistributableSubject } from "@/api/lib/case-law/public-subject";
import type { RedistributableDecisionSubject } from "@/api/lib/case-law/public-subject";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

/** Ids in a fixed order: the canonical version is the lowest decision id. */
const decisionId = (value: number): SafeId<"caseLawDecision"> =>
  toSafeId<"caseLawDecision">(
    `10000000-0000-7000-8000-${String(value).padStart(12, "0")}`,
  );
const citationId = (value: number): SafeId<"caseLawCitation"> =>
  toSafeId<"caseLawCitation">(
    `20000000-0000-7000-8000-${String(value).padStart(12, "0")}`,
  );

const sourceId = toSafeId<"caseLawSource">(
  "30000000-0000-7000-8000-000000000001",
);

/** The judgment read in three languages. */
const WORK = {
  cs: decisionId(1),
  de: decisionId(2),
  en: decisionId(3),
} as const;
const WORK_VERSIONS = [WORK.cs, WORK.de, WORK.en] as const;
/** A judgment held in two languages, each version citing the work's own. */
const CITER = { cs: decisionId(11), de: decisionId(12) } as const;
/** A judgment held once, citing the German version. */
const LONE_CITER = decisionId(13);
/** A judgment the work cites, held in two languages. */
const CITED = { cs: decisionId(21), en: decisionId(22) } as const;
/** A judgment only the English version cites. */
const CITED_BY_ENGLISH = decisionId(23);

/** A decision that is its work's only version, citing and cited once. */
const SINGLE = decisionId(31);
const SINGLE_PARTNER = decisionId(32);
/** A one-version decision cited by both versions of one judgment. */
const SINGLE_CITED_TWICE = decisionId(33);
const TWO_VERSION_CITER = { cs: decisionId(34), de: decisionId(35) } as const;

/** Two Czech decisions one ECLI-less docket groups, and an English row. */
const DOCKET = {
  first: decisionId(41),
  second: decisionId(42),
  english: decisionId(43),
} as const;
const DOCKET_CITERS = [decisionId(44), decisionId(45), decisionId(46)] as const;

const WORK_GROUP = "ECLI:XX:TEST:2099:1";
const CITER_GROUP = "ECLI:XX:TEST:2099:2";
const CITED_GROUP = "ECLI:XX:TEST:2099:3";
const TWO_VERSION_CITER_GROUP = "ECLI:XX:TEST:2099:4";
/** The docket fallback key: `${sourceId}:${caseNumber}`. */
const DOCKET_GROUP = `${sourceId}:docket-1`;

const UNRESOLVED_TEXT = "C-1/99";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let caseLawDb: CaseLawPublicReadDb;

const decisionRow = ({
  id,
  caseNumber,
  language,
  languageGroupKey,
}: {
  id: SafeId<"caseLawDecision">;
  caseNumber: string;
  language: string;
  languageGroupKey: string | null;
}): typeof caseLawDecisions.$inferInsert => ({
  id,
  caseNumber,
  country: "CZE",
  court: "Court",
  decisionDate: "2020-01-01",
  language,
  languageGroupKey,
  slug: `fixture-${id.slice(-4)}`,
  sourceId,
});

const edge = ({
  id,
  citing,
  cited,
  text,
  sectionIndex = 0,
}: {
  id: number;
  citing: SafeId<"caseLawDecision">;
  cited: SafeId<"caseLawDecision"> | null;
  text: string;
  sectionIndex?: number;
}): typeof caseLawCitations.$inferInsert => ({
  id: citationId(id),
  citingDecisionId: citing,
  citedDecisionId: cited,
  citationText: text,
  kind: CITATION_KIND.PRECEDENT,
  sectionIndex,
});

// timeout: a fresh PGlite build with every migration outlasts the default hook budget.
beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });
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
      .values(caseLawSourceRow({ id: sourceId, name: "fixture" }));
    await db.insert(caseLawDecisions).values([
      decisionRow({
        id: WORK.cs,
        caseNumber: "work",
        language: "cs",
        languageGroupKey: WORK_GROUP,
      }),
      decisionRow({
        id: WORK.de,
        caseNumber: "work",
        language: "de",
        languageGroupKey: WORK_GROUP,
      }),
      decisionRow({
        id: WORK.en,
        caseNumber: "work",
        language: "en",
        languageGroupKey: WORK_GROUP,
      }),
      decisionRow({
        id: CITER.cs,
        caseNumber: "citer",
        language: "cs",
        languageGroupKey: CITER_GROUP,
      }),
      decisionRow({
        id: CITER.de,
        caseNumber: "citer",
        language: "de",
        languageGroupKey: CITER_GROUP,
      }),
      decisionRow({
        id: LONE_CITER,
        caseNumber: "lone-citer",
        language: "de",
        languageGroupKey: null,
      }),
      decisionRow({
        id: CITED.cs,
        caseNumber: "cited",
        language: "cs",
        languageGroupKey: CITED_GROUP,
      }),
      decisionRow({
        id: CITED.en,
        caseNumber: "cited",
        language: "en",
        languageGroupKey: CITED_GROUP,
      }),
      decisionRow({
        id: CITED_BY_ENGLISH,
        caseNumber: "cited-by-english",
        language: "en",
        languageGroupKey: null,
      }),
      decisionRow({
        id: SINGLE,
        caseNumber: "single",
        language: "cs",
        languageGroupKey: "ECLI:XX:TEST:2099:5",
      }),
      decisionRow({
        id: SINGLE_PARTNER,
        caseNumber: "single-partner",
        language: "cs",
        languageGroupKey: null,
      }),
      decisionRow({
        id: SINGLE_CITED_TWICE,
        caseNumber: "single-cited-twice",
        language: "cs",
        languageGroupKey: null,
      }),
      decisionRow({
        id: TWO_VERSION_CITER.cs,
        caseNumber: "two-version-citer",
        language: "cs",
        languageGroupKey: TWO_VERSION_CITER_GROUP,
      }),
      decisionRow({
        id: TWO_VERSION_CITER.de,
        caseNumber: "two-version-citer",
        language: "de",
        languageGroupKey: TWO_VERSION_CITER_GROUP,
      }),
      decisionRow({
        id: DOCKET.first,
        caseNumber: "docket-1/a",
        language: "cs",
        languageGroupKey: DOCKET_GROUP,
      }),
      decisionRow({
        id: DOCKET.second,
        caseNumber: "docket-1/b",
        language: "cs",
        languageGroupKey: DOCKET_GROUP,
      }),
      decisionRow({
        id: DOCKET.english,
        caseNumber: "docket-1/c",
        language: "en",
        languageGroupKey: DOCKET_GROUP,
      }),
      ...DOCKET_CITERS.map((id, index) =>
        decisionRow({
          id,
          caseNumber: `docket-citer-${String(index)}`,
          language: "cs",
          languageGroupKey: null,
        }),
      ),
    ]);

    await db.insert(caseLawCitations).values([
      // Into the work: each version of the citer resolved to its language.
      edge({ id: 1, citing: CITER.cs, cited: WORK.cs, text: "C-1/24" }),
      edge({ id: 2, citing: CITER.de, cited: WORK.de, text: "C-1/24" }),
      edge({ id: 3, citing: LONE_CITER, cited: WORK.de, text: "C-1/24" }),
      // Out of the work: the Czech version cites the two-language judgment
      // twice (two mentions stay two) and prints one unresolved reference.
      edge({ id: 10, citing: WORK.cs, cited: CITED.cs, text: "C-2/20" }),
      edge({ id: 11, citing: WORK.cs, cited: null, text: UNRESOLVED_TEXT }),
      edge({
        id: 15,
        citing: WORK.cs,
        cited: CITED.cs,
        text: "C-2/20",
        sectionIndex: 3,
      }),
      // The English version repeats both, and carries one of its own.
      edge({ id: 12, citing: WORK.en, cited: CITED.en, text: "C-2/20" }),
      edge({ id: 13, citing: WORK.en, cited: null, text: UNRESOLVED_TEXT }),
      edge({
        id: 14,
        citing: WORK.en,
        cited: CITED_BY_ENGLISH,
        text: "C-3/21",
      }),
      // A one-version decision.
      edge({ id: 30, citing: SINGLE_PARTNER, cited: SINGLE, text: "single" }),
      edge({ id: 31, citing: SINGLE, cited: SINGLE_PARTNER, text: "partner" }),
      edge({
        id: 32,
        citing: TWO_VERSION_CITER.cs,
        cited: SINGLE_CITED_TWICE,
        text: "twice",
      }),
      edge({
        id: 33,
        citing: TWO_VERSION_CITER.de,
        cited: SINGLE_CITED_TWICE,
        text: "twice",
      }),
      // Distinct decisions of one docket keep their own citations.
      edge({
        id: 40,
        citing: DOCKET_CITERS[0],
        cited: DOCKET.first,
        text: "d",
      }),
      edge({
        id: 41,
        citing: DOCKET_CITERS[1],
        cited: DOCKET.second,
        text: "d",
      }),
      edge({
        id: 42,
        citing: DOCKET_CITERS[2],
        cited: DOCKET.second,
        text: "d",
      }),
    ]);
  },
  { timeout: 120_000 },
);

afterAll(async () => {
  await client.close();
});

const withSubject = async <T>(
  id: SafeId<"caseLawDecision">,
  read: (subject: RedistributableDecisionSubject) => Promise<T>,
): Promise<T> =>
  (await withRedistributableSubject(
    caseLawDb,
    "pages",
    { kind: "id", id },
    read,
  )) ?? panic("expected a redistributable subject");

/** Every page of the graph list, as citation ids and far decisions. */
const listAll = async (
  id: SafeId<"caseLawDecision">,
  direction: CitationDirection,
) => {
  const rows: { id: string; related: string | null; text: string }[] = [];
  let cursor: string | undefined;
  for (let request = 0; request < 10; request += 1) {
    const pageCursor = cursor;
    const page = await withSubject(
      id,
      async (subject) =>
        await listDecisionCitationsHandler({
          subject,
          query: {
            direction,
            ...(pageCursor === undefined ? {} : { cursor: pageCursor }),
          },
        }),
    );
    if (!("items" in page)) {
      return panic("expected a citation page");
    }
    rows.push(
      ...page.items.map((item) => ({
        id: item.id,
        related: item.decision?.id ?? null,
        text: item.citationText,
      })),
    );
    cursor = page.nextCursor ?? undefined;
    if (cursor === undefined) {
      return rows;
    }
  }
  return panic("the citation list did not terminate");
};

const summaryOf = async (id: SafeId<"caseLawDecision">) =>
  await withSubject(id, async (subject) => {
    const summary = await summarizeDecisionCitationsHandler({
      subject,
      currentYear: 2026,
    });
    const top = await listTopCitingDecisionsHandler({
      subject,
      summary,
      limit: 10,
    });
    const leading = {
      incoming: await listLeadingCitationsHandler({
        subject,
        query: { direction: "incoming" },
      }),
      outgoing: await listLeadingCitationsHandler({
        subject,
        query: { direction: "outgoing" },
      }),
    };
    const total = (direction: CitationDirection) =>
      Object.values(summary[direction]).reduce((sum, count) => sum + count, 0);
    return {
      summary,
      incoming: total("incoming"),
      outgoing: total("outgoing"),
      top: top.items.map((item) => item.id),
      leading: {
        incoming: leading.incoming.items.map((item) => item.decision.id),
        outgoing: leading.outgoing.items.map((item) => item.decision.id),
      },
    };
  });

/** The reader's citation streams, as their item ids. */
const readerStreams = async (id: SafeId<"caseLawDecision">) =>
  await withSubject(id, async (subject) => {
    const options = {
      tx: subject.tx,
      cursor: undefined,
      work: await readDecisionWork(subject.tx, subject.id),
      countries: subject.countries,
    };
    const outgoing = await listOutgoingDecisionCitations(options);
    const incoming = await listIncomingDecisionCitations(options);
    if (!("items" in outgoing) || !("items" in incoming)) {
      return panic("expected reader citation pages");
    }
    return {
      outgoing: outgoing.items.map((item) => item.id),
      incoming: incoming.items.map((item) => item.id),
    };
  });

const sweep = async () => {
  let after: string | null = null;
  for (let turn = 0; turn < 20; turn += 1) {
    const position: string | null = after;
    const batch: Awaited<ReturnType<typeof recomputeCitationAuthorityBatch>> =
      await db.transaction(
        async (tx) =>
          await recomputeCitationAuthorityBatch(tx, {
            after: position,
            limit: 7,
            now: { type: "pinned", at: new Date("2026-06-01T00:00:00Z") },
            courtWeightEntries: [],
          }),
      );
    after = batch.lastId;
    if (batch.scanned < 7) {
      return;
    }
  }
  panic("the sweep did not terminate");
};

const countsOf = async (ids: readonly SafeId<"caseLawDecision">[]) => {
  const rows = await db
    .select({
      id: caseLawDecisions.id,
      count: caseLawDecisions.citationCount,
      authority: caseLawDecisions.citationAuthority,
    })
    .from(caseLawDecisions)
    .where(inArray(caseLawDecisions.id, [...ids]));
  return new Map(rows.map((row) => [row.id, row]));
};

describe("a judgment held in several languages", () => {
  test("the fixture spreads the edges over different versions", async () => {
    // Read per row, the versions disagree: the fault the reads must not show.
    const perRow = await db
      .select({ cited: caseLawCitations.citedDecisionId })
      .from(caseLawCitations)
      .where(inArray(caseLawCitations.citedDecisionId, [...WORK_VERSIONS]));
    const incomingPerRow = WORK_VERSIONS.map(
      (id) => perRow.filter((row) => row.cited === id).length,
    );
    expect(incomingPerRow).toEqual([1, 2, 0]);
    const work = await withSubject(
      WORK.de,
      async (subject) => await readDecisionWork(subject.tx, subject.id),
    );
    expect(work.manifestationIds).toEqual([...WORK_VERSIONS]);
  });

  test("every version lists the same citations, each once", async () => {
    const expectedIncoming = [
      { id: citationId(1), related: CITER.cs, text: "C-1/24" },
      { id: citationId(3), related: LONE_CITER, text: "C-1/24" },
    ];
    const expectedOutgoing = [
      { id: citationId(10), related: CITED.cs, text: "C-2/20" },
      { id: citationId(11), related: null, text: UNRESOLVED_TEXT },
      { id: citationId(14), related: CITED_BY_ENGLISH, text: "C-3/21" },
      { id: citationId(15), related: CITED.cs, text: "C-2/20" },
    ];
    for (const version of WORK_VERSIONS) {
      expect(await listAll(version, "incoming")).toEqual(expectedIncoming);
      expect(await listAll(version, "outgoing")).toEqual(expectedOutgoing);
      expect(await readerStreams(version)).toEqual({
        incoming: expectedIncoming.map((row) => row.id),
        outgoing: expectedOutgoing.map((row) => row.id),
      });
    }
  });

  test("every version reads the same summary, top citers and leaders", async () => {
    const reads = await Promise.all(WORK_VERSIONS.map(summaryOf));
    const [first, ...rest] = reads;
    expect(first?.incoming).toBe(2);
    expect(first?.outgoing).toBe(4);
    expect(first?.top).toEqual([CITER.cs, LONE_CITER]);
    expect(first?.leading.incoming.toSorted()).toEqual(
      [CITER.cs, LONE_CITER].toSorted(),
    );
    expect(first?.leading.outgoing.toSorted()).toEqual(
      [CITED.cs, CITED_BY_ENGLISH].toSorted(),
    );
    for (const read of rest) {
      expect(read).toEqual(first ?? panic("expected a first read"));
    }
  });

  test("the materialized count is the work's, on every version", async () => {
    await sweep();
    const counts = await countsOf([
      ...WORK_VERSIONS,
      CITED.cs,
      CITED.en,
      CITED_BY_ENGLISH,
    ]);
    for (const version of WORK_VERSIONS) {
      expect(counts.get(version)?.count).toBe(2);
      expect(counts.get(version)?.authority).toBe(
        counts.get(WORK.cs)?.authority ?? panic("expected an authority"),
      );
    }
    // Two mentions in one text are two citations; the other version's copy
    // of them is not a third.
    expect(counts.get(CITED.cs)?.count).toBe(2);
    expect(counts.get(CITED.en)?.count).toBe(2);
    expect(counts.get(CITED_BY_ENGLISH)?.count).toBe(1);
  });
});

describe("decisions that are their work's only version", () => {
  test("a one-version decision reads as before", async () => {
    expect(await listAll(SINGLE, "incoming")).toEqual([
      { id: citationId(30), related: SINGLE_PARTNER, text: "single" },
    ]);
    expect(await listAll(SINGLE, "outgoing")).toEqual([
      { id: citationId(31), related: SINGLE_PARTNER, text: "partner" },
    ]);
    const read = await summaryOf(SINGLE);
    expect(read.incoming).toBe(1);
    expect(read.outgoing).toBe(1);
    expect(read.top).toEqual([SINGLE_PARTNER]);
  });

  test("two versions of one citing judgment cite a one-version decision once", async () => {
    expect(await listAll(SINGLE_CITED_TWICE, "incoming")).toEqual([
      {
        id: citationId(32),
        related: TWO_VERSION_CITER.cs,
        text: "twice",
      },
    ]);
    expect((await summaryOf(SINGLE_CITED_TWICE)).incoming).toBe(1);
    await sweep();
    expect(
      (await countsOf([SINGLE_CITED_TWICE])).get(SINGLE_CITED_TWICE)?.count,
    ).toBe(1);
  });

  test("same-language decisions of one docket keep their own citations", async () => {
    const works = await withSubject(
      DOCKET.english,
      async (subject) =>
        await Promise.all(
          [DOCKET.first, DOCKET.second, DOCKET.english].map(
            async (id) => await readDecisionWork(subject.tx, id),
          ),
        ),
    );
    expect(works.map((work) => work.manifestationIds)).toEqual([
      [DOCKET.first],
      [DOCKET.second],
      [DOCKET.english],
    ]);
    expect((await summaryOf(DOCKET.first)).incoming).toBe(1);
    expect((await summaryOf(DOCKET.second)).incoming).toBe(2);
    expect((await summaryOf(DOCKET.english)).incoming).toBe(0);
    await sweep();
    const counts = await countsOf([
      DOCKET.first,
      DOCKET.second,
      DOCKET.english,
    ]);
    expect(counts.get(DOCKET.first)?.count).toBe(1);
    expect(counts.get(DOCKET.second)?.count).toBe(2);
    expect(counts.get(DOCKET.english)?.count).toBe(0);
  });
});
