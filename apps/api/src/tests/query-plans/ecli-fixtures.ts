import { and, eq, inArray, or } from "drizzle-orm";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import type { Transaction } from "@/api/db/root";
import { caseLawDecisionIdentifiers, caseLawDecisions } from "@/api/db/schema";
import { normalizeDecisionIdentifierValue } from "@/api/handlers/case-law/ingestion/citation-extractor";
import { LIMITS } from "@/api/lib/limits";
import { QUERY_PLAN_SAMPLE } from "@/api/tests/query-plans/seed";

const ECLI = QUERY_PLAN_SAMPLE.caseLaw.sharedEcli;
const ECLI_NORMALIZED = normalizeDecisionIdentifierValue(
  DECISION_IDENTIFIER_TYPES.ECLI,
  ECLI,
);

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
