/**
 * The judges a decision names, against the real schema.
 *
 * Four things only the database decides are exercised here: which name finds
 * a roster row, which roster row a declined name is, that a replacement leaves
 * nothing of the previous write behind, and that a roster import links the
 * names that were waiting for it.
 */

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisionJudges,
  caseLawDecisions,
  caseLawJudges,
  caseLawSources,
} from "@/api/db/schema";
import { DECISION_JUDGE_ROLE } from "@/api/handlers/case-law/judges/consts";
import {
  relinkUnmatchedDecisionJudgesPage,
  replaceDecisionJudges,
} from "@/api/handlers/case-law/judges/decision-judges";
import type { RelinkUnmatchedDecisionJudgesPage } from "@/api/handlers/case-law/judges/decision-judges";
import { judgeNameKey } from "@/api/handlers/case-law/judges/judge-name";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/** Same budget as the schema push: an embedded Postgres is not fast. */
const DB_TEST_TIMEOUT_MS = 120_000;

const COUNTRY = "CZE";
const COURT = "Ústavní soud";
const OTHER_COURT = "Nejvyšší soud";

const sourceId = createSafeId<"caseLawSource">();
const decisionId = createSafeId<"caseLawDecision">();
const otherCourtDecisionId = createSafeId<"caseLawDecision">();
const benchDecisionId = createSafeId<"caseLawDecision">();

const RAPPORTEUR = "JUDr. Vojtěch Šimáček";
const DISSENTING = "Mgr. Ludmila Nováková";
const LATE_ARRIVAL = "Radomír Čapek";

let client: PGlite;
let db: ReturnType<typeof drizzle>;

// The pglite handle stands in for a transaction, matching the pattern the
// other case-law database tests use for their fakes.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test handle stands in for a transaction
const asTx = () => db as unknown as Transaction;

const insertJudge = async (
  fullName: string,
  court: string = COURT,
): Promise<SafeId<"caseLawJudge">> => {
  const id = createSafeId<"caseLawJudge">();
  await db.insert(caseLawJudges).values({
    id,
    country: COUNTRY,
    court,
    fullName,
    nameKey: judgeNameKey(fullName),
  });
  return id;
};

const storedJudges = async (decision: SafeId<"caseLawDecision">) =>
  await db
    .select({
      role: caseLawDecisionJudges.role,
      name: caseLawDecisionJudges.nameAsPrinted,
      nameKey: caseLawDecisionJudges.nameKey,
      judgeId: caseLawDecisionJudges.judgeId,
      position: caseLawDecisionJudges.position,
    })
    .from(caseLawDecisionJudges)
    .where(eq(caseLawDecisionJudges.decisionId, decision))
    .orderBy(
      asc(caseLawDecisionJudges.role),
      asc(caseLawDecisionJudges.position),
    );

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });

  await db.insert(caseLawSources).values(caseLawSourceRow({ id: sourceId }));
  await db.insert(caseLawDecisions).values([
    {
      id: decisionId,
      sourceId,
      caseNumber: "II. ÚS 1/2026",
      court: COURT,
      country: COUNTRY,
      language: "cs",
      languageGroupKey: "judges-decision",
    },
    {
      id: benchDecisionId,
      sourceId,
      caseNumber: "III. ÚS 290/26",
      court: COURT,
      country: COUNTRY,
      language: "cs",
      languageGroupKey: "judges-bench",
    },
    {
      id: otherCourtDecisionId,
      sourceId,
      caseNumber: "30 Cdo 1/2026",
      court: OTHER_COURT,
      country: COUNTRY,
      language: "cs",
      languageGroupKey: "judges-other-court",
    },
  ]);
}, DB_TEST_TIMEOUT_MS);

afterAll(async () => {
  await client.close();
});

test(
  "stores a matched name against the roster and an unmatched one without it",
  async () => {
    const rapporteurId = await insertJudge(RAPPORTEUR);

    await replaceDecisionJudges(asTx(), {
      decisionId,
      judges: [
        { role: DECISION_JUDGE_ROLE.RAPPORTEUR, nameAsPrinted: RAPPORTEUR },
        { role: DECISION_JUDGE_ROLE.DISSENTING, nameAsPrinted: DISSENTING },
      ],
    });

    expect(await storedJudges(decisionId)).toEqual([
      {
        role: DECISION_JUDGE_ROLE.DISSENTING,
        name: DISSENTING,
        nameKey: judgeNameKey(DISSENTING),
        judgeId: null,
        position: 0,
      },
      {
        role: DECISION_JUDGE_ROLE.RAPPORTEUR,
        name: RAPPORTEUR,
        nameKey: judgeNameKey(RAPPORTEUR),
        judgeId: rapporteurId,
        position: 0,
      },
    ]);
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "a second write replaces the decision's judges rather than adding to them",
  async () => {
    await replaceDecisionJudges(asTx(), {
      decisionId,
      judges: [
        { role: DECISION_JUDGE_ROLE.DISSENTING, nameAsPrinted: DISSENTING },
        { role: DECISION_JUDGE_ROLE.DISSENTING, nameAsPrinted: LATE_ARRIVAL },
        // The same name twice in one role is one row: the second mention
        // states nothing the first did not.
        { role: DECISION_JUDGE_ROLE.DISSENTING, nameAsPrinted: DISSENTING },
      ],
    });

    expect(await storedJudges(decisionId)).toEqual([
      {
        role: DECISION_JUDGE_ROLE.DISSENTING,
        name: DISSENTING,
        nameKey: judgeNameKey(DISSENTING),
        judgeId: null,
        position: 0,
      },
      {
        role: DECISION_JUDGE_ROLE.DISSENTING,
        name: LATE_ARRIVAL,
        nameKey: judgeNameKey(LATE_ARRIVAL),
        judgeId: null,
        position: 1,
      },
    ]);
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "a roster import links the names that were waiting for it, and only its own court's",
  async () => {
    await replaceDecisionJudges(asTx(), {
      decisionId,
      judges: [
        { role: DECISION_JUDGE_ROLE.RAPPORTEUR, nameAsPrinted: LATE_ARRIVAL },
      ],
    });
    await replaceDecisionJudges(asTx(), {
      decisionId: otherCourtDecisionId,
      judges: [
        { role: DECISION_JUDGE_ROLE.RAPPORTEUR, nameAsPrinted: LATE_ARRIVAL },
      ],
    });

    // The name reaches the roster only now, and a judge of another court
    // happens to be spelled the same.
    const lateId = await insertJudge(LATE_ARRIVAL);
    await insertJudge(LATE_ARRIVAL, OTHER_COURT);

    expect(
      await relinkUnmatchedDecisionJudgesPage(asTx(), {
        country: COUNTRY,
        court: COURT,
        after: null,
        size: 10,
      }),
    ).toEqual({ linked: 1, cursor: decisionId, done: true });

    expect((await storedJudges(decisionId)).at(0)?.judgeId).toBe(lateId);
    expect(
      (await storedJudges(otherCourtDecisionId)).at(0)?.judgeId,
    ).toBeNull();

    // Nothing is left to link, so a second walk covers nothing and keeps the
    // cursor it was given.
    expect(
      await relinkUnmatchedDecisionJudgesPage(asTx(), {
        country: COUNTRY,
        court: COURT,
        after: null,
        size: 10,
      }),
    ).toEqual({ linked: 0, cursor: null, done: true });
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "the relink walks a court's decisions page by page and links each one once",
  async () => {
    const PAGED = "Kateřina Ronovská";
    const pagedIds = [
      createSafeId<"caseLawDecision">(),
      createSafeId<"caseLawDecision">(),
      createSafeId<"caseLawDecision">(),
    ].toSorted();
    await db.insert(caseLawDecisions).values(
      pagedIds.map((id, index) => ({
        id,
        sourceId,
        caseNumber: `IV. ÚS ${index + 10}/2026`,
        court: COURT,
        country: COUNTRY,
        language: "cs",
        languageGroupKey: `judges-paged-${index}`,
      })),
    );
    for (const id of pagedIds) {
      await replaceDecisionJudges(asTx(), {
        decisionId: id,
        judges: [
          { role: DECISION_JUDGE_ROLE.RAPPORTEUR, nameAsPrinted: PAGED },
          { role: DECISION_JUDGE_ROLE.DISSENTING, nameAsPrinted: PAGED },
        ],
      });
    }
    const pagedJudgeId = await insertJudge(PAGED);

    // A page of one decision still settles both of that decision's rows, so
    // the cursor never leaves half a decision behind it.
    const pages: RelinkUnmatchedDecisionJudgesPage[] = [];
    let after: SafeId<"caseLawDecision"> | null = null;
    while (true) {
      const page = await relinkUnmatchedDecisionJudgesPage(asTx(), {
        country: COUNTRY,
        court: COURT,
        after,
        size: 1,
      });
      pages.push(page);
      if (page.done) {
        break;
      }
      after = page.cursor;
    }

    expect(pages).toEqual([
      ...pagedIds.map((id) => ({ linked: 2, cursor: id, done: false })),
      { linked: 0, cursor: pagedIds.at(-1) ?? null, done: true },
    ]);
    for (const id of pagedIds) {
      expect((await storedJudges(id)).map(({ judgeId }) => judgeId)).toEqual([
        pagedJudgeId,
        pagedJudgeId,
      ]);
    }
  },
  DB_TEST_TIMEOUT_MS,
);

test("a declined bench is stored under the roster's names, and a name it cannot place is left out", async () => {
  const svatonId = await insertJudge("Jan Svatoň");
  const hulmakId = await insertJudge("Milan Hulmák");
  const zemanovaId = await insertJudge("Daniela Zemanová");
  // Two rows a declined "Jana Zemana" could be: neither is chosen.
  await insertJudge("Jan Zeman");
  await insertJudge("Jana Zemanová");

  await replaceDecisionJudges(asTx(), {
    decisionId: benchDecisionId,
    judges: [
      // The opening sentence: "z předsedy Jana Svatoně (soudce
      // zpravodaje), soudce Milana Hulmáka a soudkyně Daniely Zemanové".
      {
        role: DECISION_JUDGE_ROLE.PRESIDING,
        czechDeclinedName: "Jana Svatoně",
      },
      {
        role: DECISION_JUDGE_ROLE.RAPPORTEUR,
        czechDeclinedName: "Jana Svatoně",
      },
      {
        role: DECISION_JUDGE_ROLE.PANEL_MEMBER,
        czechDeclinedName: "Milana Hulmáka",
      },
      {
        role: DECISION_JUDGE_ROLE.PANEL_MEMBER,
        czechDeclinedName: "Daniely Zemanové",
      },
      {
        role: DECISION_JUDGE_ROLE.PANEL_MEMBER,
        czechDeclinedName: "Petra Nováka",
      },
      {
        role: DECISION_JUDGE_ROLE.PANEL_MEMBER,
        czechDeclinedName: "Jana Zemana",
      },
      // The record card, surname first, after the sentence as the adapter
      // orders them.
      { role: DECISION_JUDGE_ROLE.RAPPORTEUR, nameAsPrinted: "Svatoň Jan" },
    ],
  });

  expect(await storedJudges(benchDecisionId)).toEqual([
    {
      role: DECISION_JUDGE_ROLE.PANEL_MEMBER,
      name: "Milan Hulmák",
      nameKey: judgeNameKey("Milan Hulmák"),
      judgeId: hulmakId,
      position: 0,
    },
    {
      role: DECISION_JUDGE_ROLE.PANEL_MEMBER,
      name: "Daniela Zemanová",
      nameKey: judgeNameKey("Daniela Zemanová"),
      judgeId: zemanovaId,
      position: 1,
    },
    {
      role: DECISION_JUDGE_ROLE.PRESIDING,
      name: "Jan Svatoň",
      nameKey: judgeNameKey("Jan Svatoň"),
      judgeId: svatonId,
      position: 0,
    },
    // The card and the sentence name one rapporteur, so one row, under
    // the name the sentence resolved to.
    {
      role: DECISION_JUDGE_ROLE.RAPPORTEUR,
      name: "Jan Svatoň",
      nameKey: judgeNameKey("Jan Svatoň"),
      judgeId: svatonId,
      position: 0,
    },
  ]);
});
