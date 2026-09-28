import { and, eq, inArray, or } from "drizzle-orm";
import { alias, unionAll } from "drizzle-orm/pg-core";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import type { Transaction } from "@/api/db/root";
import { caseLawDecisionIdentifiers, caseLawDecisions } from "@/api/db/schema";
import { LIMITS } from "@/api/lib/limits";
import { QUERY_PLAN_SAMPLE } from "@/api/tests/query-plans/seed";

const ECLI = QUERY_PLAN_SAMPLE.caseLaw.sharedEcli;
const ECLI_NORMALIZED = "eclieuc202412";
const ecliDecisions = alias(caseLawDecisions, "ecli_decisions");

/** Test-local copy of the indexed UNION identity lookup in #4050. */
export const ecliUnionFixtureQuery = (tx: Transaction) =>
  tx
    .select({ id: caseLawDecisions.id })
    .from(caseLawDecisions)
    .where(
      and(
        inArray(
          caseLawDecisions.id,
          unionAll(
            tx
              .select({ id: ecliDecisions.id })
              .from(ecliDecisions)
              .where(inArray(ecliDecisions.ecli, [ECLI, ECLI.toUpperCase()])),
            tx
              .select({ id: caseLawDecisionIdentifiers.decisionId })
              .from(caseLawDecisionIdentifiers)
              .where(
                and(
                  eq(
                    caseLawDecisionIdentifiers.type,
                    DECISION_IDENTIFIER_TYPES.ECLI,
                  ),
                  eq(
                    caseLawDecisionIdentifiers.normalizedValue,
                    ECLI_NORMALIZED,
                  ),
                ),
              ),
          ),
        ),
        eq(caseLawDecisions.country, QUERY_PLAN_SAMPLE.caseLaw.country),
      ),
    )
    .limit(LIMITS.caseLawSearchPageSizeMax);

/** Test-local copy of the pre-fix OR/subquery identity shape. */
export const ecliOrFixtureQuery = (tx: Transaction) =>
  tx
    .select({ id: caseLawDecisions.id })
    .from(caseLawDecisions)
    .where(
      and(
        or(
          inArray(caseLawDecisions.ecli, [ECLI, ECLI.toUpperCase()]),
          inArray(
            caseLawDecisions.id,
            tx
              .select({ id: caseLawDecisionIdentifiers.decisionId })
              .from(caseLawDecisionIdentifiers)
              .where(
                and(
                  eq(
                    caseLawDecisionIdentifiers.type,
                    DECISION_IDENTIFIER_TYPES.ECLI,
                  ),
                  eq(
                    caseLawDecisionIdentifiers.normalizedValue,
                    ECLI_NORMALIZED,
                  ),
                ),
              ),
          ),
        ),
        eq(caseLawDecisions.country, QUERY_PLAN_SAMPLE.caseLaw.country),
      ),
    )
    .limit(LIMITS.caseLawSearchPageSizeMax);
