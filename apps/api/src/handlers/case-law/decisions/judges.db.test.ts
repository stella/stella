/**
 * The judges a decision read answers with.
 *
 * This is the array the reader renders, so the order is part of the contract:
 * the rapporteur signs the decision and comes first, the dissenters follow in
 * the order the decision prints them. The order is decided in SQL, and the
 * portrait link is built from a row the reader role may only partly read, so
 * both are exercised against the database under that role.
 */

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";

import { authRelationsPart } from "@/api/db/auth-schema";
import {
  caseLawDecisionJudges,
  caseLawDecisions,
  caseLawJudges,
  caseLawSources,
  relations,
} from "@/api/db/schema";
import { readDecisionHandler } from "@/api/handlers/case-law/decisions/get";
import {
  DECISION_JUDGE_ROLE,
  PORTRAIT_SOURCE,
} from "@/api/handlers/case-law/judges/consts";
import { judgeNameKey } from "@/api/handlers/case-law/judges/judge-name";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { withRedistributableSubject } from "@/api/lib/case-law/public-subject";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

/** Same budget as the schema push: an embedded Postgres is not fast. */
const DB_TEST_TIMEOUT_MS = 120_000;

const COUNTRY = "CZE";
const COURT = "Ústavní soud";

const sourceId = createSafeId<"caseLawSource">();
const decisionId = createSafeId<"caseLawDecision">();
const rapporteurId = createSafeId<"caseLawJudge">();

const RAPPORTEUR = "Vojtěch Šimáček";
const FIRST_DISSENTER = "Ludmila Nováková";
const SECOND_DISSENTER = "Radomír Čapek";

let client: PGlite;
let caseLawDb: CaseLawPublicReadDb;

const readJudges = async () =>
  await withRedistributableSubject(
    caseLawDb,
    { kind: "id", id: decisionId },
    async (subject) => {
      const decision = await readDecisionHandler({
        subject,
        readCourtWeights: async () => await Promise.resolve(new Map()),
      });
      return "judges" in decision ? decision.judges : null;
    },
  );

beforeAll(async () => {
  client = await createTestPglite();
  const db = drizzle({
    client,
    relations: { ...relations, ...authRelationsPart },
  });
  const readDb = async <T>(
    fn: (tx: CaseLawPublicReadTransaction) => Promise<T>,
  ) =>
    await withPublicLawReaderRole(db, async (roleTx) => {
      // SAFETY: the role transaction supplies the select surface the reads use.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test handle stands in for a transaction
      const tx = roleTx as unknown as CaseLawPublicReadTransaction;
      return await fn(tx);
    });
  // SAFETY: brand-only wrapper; the reads never inspect the marker.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the branded handle carries no behaviour
  caseLawDb = readDb as unknown as CaseLawPublicReadDb;

  await db.insert(caseLawSources).values(caseLawSourceRow({ id: sourceId }));
  await db.insert(caseLawDecisions).values({
    id: decisionId,
    sourceId,
    caseNumber: "I. ÚS 2/2026",
    court: COURT,
    country: COUNTRY,
    language: "cs",
    languageGroupKey: "judges-read",
    fulltext: "Decision text.",
  });
  await db.insert(caseLawJudges).values({
    id: rapporteurId,
    country: COUNTRY,
    court: COURT,
    fullName: RAPPORTEUR,
    nameKey: judgeNameKey(RAPPORTEUR),
    portraitS3Key: `case-law/judges/${rapporteurId}.jpg`,
    portraitSource: PORTRAIT_SOURCE.COURT_OFFICIAL,
    portraitAttribution: COURT,
    portraitContentType: "image/jpeg",
  });
  // Written in the reverse of the answered order, so an answer that merely
  // preserved insertion order would fail.
  await db.insert(caseLawDecisionJudges).values([
    {
      decisionId,
      judgeId: null,
      nameAsPrinted: SECOND_DISSENTER,
      nameKey: judgeNameKey(SECOND_DISSENTER),
      role: DECISION_JUDGE_ROLE.DISSENTING,
      position: 1,
    },
    {
      decisionId,
      judgeId: null,
      nameAsPrinted: FIRST_DISSENTER,
      nameKey: judgeNameKey(FIRST_DISSENTER),
      role: DECISION_JUDGE_ROLE.DISSENTING,
      position: 0,
    },
    {
      decisionId,
      judgeId: rapporteurId,
      nameAsPrinted: RAPPORTEUR,
      nameKey: judgeNameKey(RAPPORTEUR),
      role: DECISION_JUDGE_ROLE.RAPPORTEUR,
      position: 0,
    },
  ]);
}, DB_TEST_TIMEOUT_MS);

afterAll(async () => {
  await client.close();
});

test(
  "answers the rapporteur first, then the dissenters as printed",
  async () => {
    expect(await readJudges()).toEqual([
      {
        role: DECISION_JUDGE_ROLE.RAPPORTEUR,
        name: RAPPORTEUR,
        judgeId: rapporteurId,
        portrait: {
          url: `/v1/case/judges/${rapporteurId}/portrait`,
          attribution: COURT,
        },
      },
      {
        role: DECISION_JUDGE_ROLE.DISSENTING,
        name: FIRST_DISSENTER,
        judgeId: null,
        portrait: null,
      },
      {
        role: DECISION_JUDGE_ROLE.DISSENTING,
        name: SECOND_DISSENTER,
        judgeId: null,
        portrait: null,
      },
    ] satisfies {
      role: string;
      name: string;
      judgeId: SafeId<"caseLawJudge"> | null;
      portrait: { url: string; attribution: string } | null;
    }[]);
  },
  DB_TEST_TIMEOUT_MS,
);
