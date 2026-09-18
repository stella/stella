/**
 * The judges a decision names, against the real schema.
 *
 * Three things only the database decides are exercised here: which name finds
 * a roster row, that a replacement leaves nothing of the previous write
 * behind, and that a roster import links the names that were waiting for it.
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
  relinkUnmatchedDecisionJudges,
  replaceDecisionJudges,
} from "@/api/handlers/case-law/judges/decision-judges";
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
      await relinkUnmatchedDecisionJudges(asTx(), {
        country: COUNTRY,
        court: COURT,
      }),
    ).toEqual({ linked: 1 });

    expect((await storedJudges(decisionId)).at(0)?.judgeId).toBe(lateId);
    expect(
      (await storedJudges(otherCourtDecisionId)).at(0)?.judgeId,
    ).toBeNull();

    // Nothing is left to link, so a second run links nothing.
    expect(
      await relinkUnmatchedDecisionJudges(asTx(), {
        country: COUNTRY,
        court: COURT,
      }),
    ).toEqual({ linked: 0 });
  },
  DB_TEST_TIMEOUT_MS,
);
