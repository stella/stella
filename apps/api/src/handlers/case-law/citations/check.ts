/**
 * Checking one sentence against the decision it cites.
 *
 * The reference is resolved against the public corpus the way the search box
 * and the citator resolve one, so a citation that names no decision here is
 * answered as such rather than judged. When it does resolve, the decision's
 * passages are ranked against the sentence and one typed judgment says how
 * the court stands to it, with the passage the reading rests on.
 *
 * No generative model runs on this path. The finding is a choice among three
 * relations and one of the passages the request offered, so what comes back
 * is the court's own text and a distribution over the findings, never prose
 * about the decision.
 */

import { Result } from "better-result";
import { t } from "elysia";

import { exactDecisionMatches } from "@stll/api-contract/decision-query-intent";

import { checkCitationWithSystemOne } from "@/api/handlers/case-law/citations/check-with-system-one";
import type { SystemOneCitationCheck } from "@/api/handlers/case-law/citations/check-with-system-one";
import {
  chooseCitedDecision,
  citationCheckDecision,
  readCitedDecision,
} from "@/api/handlers/case-law/citations/check.logic";
import type {
  CitationCheckDecision,
  CitedDecisionLookup,
} from "@/api/handlers/case-law/citations/check.logic";
import { lookupDecisionsByIdentity } from "@/api/handlers/case-law/decisions/lookup-by-identity";
import type { DecisionIdentityRow } from "@/api/handlers/case-law/decisions/lookup-by-identity";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type {
  HandlerConfig,
  SafeHandlerGenerator,
} from "@/api/lib/api-handlers";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import {
  readDecisionPassageRow,
  resolveDecisionPassages,
} from "@/api/lib/case-law/decision-passages";
import type { DecisionPassageRow } from "@/api/lib/case-law/decision-passages";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { allowsDerivedAi } from "@/api/lib/legal-search/corpus-source";
import { LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";
import { SYSTEM_ONE_SOURCE_BUDGET_CHARS } from "@/api/lib/typesafe/answer-questions";
import type { AnswerSource } from "@/api/lib/typesafe/answer-questions";
import { getSystemOneClient } from "@/api/lib/typesafe/system-one-runtime";

/**
 * Why a resolved decision could not be checked. Both are properties of the
 * decision rather than of the request: a source whose terms withhold derived
 * AI use is resolved and named but never sent to a model, and a row the
 * corpus lists without holding its text has nothing to read.
 */
const CITATION_CHECK_UNAVAILABLE_REASONS = [
  "derived_ai_withheld",
  "no_text",
] as const;
type CitationCheckUnavailableReason =
  (typeof CITATION_CHECK_UNAVAILABLE_REASONS)[number];

/**
 * What the endpoint answers. Declared rather than inferred because an async
 * generator's return type does not survive `yield*` delegation, and the
 * client discriminates on `status`.
 */
type CitationCheckResponse =
  | { status: "not_found" }
  | {
      status: "unavailable";
      decision: CitationCheckDecision;
      reason: CitationCheckUnavailableReason;
    }
  | ({
      status: "checked";
      decision: CitationCheckDecision;
      /** The other decisions the same reference resolves to, most recent first. */
      alternatives: CitationCheckDecision[];
    } & SystemOneCitationCheck);

const notFound = (): Result<CitationCheckResponse, never> =>
  Result.ok({ status: "not_found" });

const unavailable = (
  decision: CitationCheckDecision,
  reason: CitationCheckUnavailableReason,
): Result<CitationCheckResponse, never> =>
  Result.ok({ status: "unavailable", decision, reason });

/**
 * The decisions that answer to the reference, across every jurisdiction whose
 * grammar claims it. A bare docket is well-formed in more than one of them,
 * so which corpus holds the decision settles it rather than the order the
 * grammars happen to be declared in.
 */
const resolveCitedDecisions = async (
  lookup: CitedDecisionLookup,
): Promise<DecisionIdentityRow[]> => {
  const perCountry = await Promise.all(
    lookup.countries.map(
      async (country) =>
        await lookupDecisionsByIdentity({
          caseLawDb: caseLawPublicReadDb,
          country,
          locator: { kind: lookup.kind, value: lookup.identifier },
        }),
    ),
  );
  // A second guard, independent of the statement above: a row counts only
  // when the reference is one of the names the decision answers to itself.
  return exactDecisionMatches(lookup.identifier, perCountry.flat());
};

/**
 * The decision as Jev reads it: whole and in reading order when it fits the
 * source budget, which a judgment usually does. Only a decision over the
 * budget is cut down to the passages retrieval ranks against the claim; a
 * claim written in another language than the decision ranks poorly, so the
 * ranked list is the fallback, never the first choice.
 */
const rankPassages = async (
  decision: DecisionPassageRow,
  claim: string,
): Promise<AnswerSource[]> => {
  const text = await resolveDecisionPassages({
    caseLawDb: caseLawPublicReadDb,
    decision,
    budgetChars: SYSTEM_ONE_SOURCE_BUDGET_CHARS,
    passageChars: LIMITS.caseLawCitationCheckPassageChars,
    maxPassages: LIMITS.caseLawCitationCheckPassagesMax,
    queries: [claim],
  });
  if (text.kind === "none") {
    return [];
  }
  return text.passages.map((passage) => ({
    id: passage.anchorId,
    text: passage.excerpt,
  }));
};

const config = {
  description:
    "Check one sentence against the court decision it cites. Resolves the " +
    "reference against the public case-law corpus, ranks the decision's " +
    "passages against the sentence, and answers whether the decision " +
    "supports, contradicts or does not address it, with the passage the " +
    "reading rests on. Answers not_found when no decision here answers to " +
    "the reference, and unavailable when the decision's source withholds " +
    "derived AI use or it has no readable text. Stores nothing.",
  // The grant an in-app AI affordance carries: a member who may read a matter
  // and spend the organization's AI on it.
  permissions: { workspace: ["read"], chat: ["create"] },
  // A document-editor affordance. An agent reaches the same corpus through
  // `lookup_case_law` and `read_case_law_decision` and forms its own view.
  mcp: { type: "internal", reason: "search_ui" },
  access: "read",
  body: t.Object({
    /** A decision reference as prose writes it, prefix and sheet included. */
    citation: t.String({
      minLength: 1,
      maxLength: LIMITS.caseLawIdentifierMaxLength,
    }),
    /** The sentence the decision is cited for, in any language. */
    claim: t.String({
      minLength: 1,
      maxLength: LIMITS.caseLawCitationCheckClaimChars,
    }),
    /** The claim's language, when the caller knows it. */
    language: t.Optional(t.String({ minLength: 2, maxLength: 8 })),
  }),
} satisfies HandlerConfig;

const checkCitation = createSafeRootHandler(
  config,
  async function* ({
    body: { citation, claim, language },
  }): SafeHandlerGenerator<CitationCheckResponse> {
    const lookup = readCitedDecision(citation);
    if (lookup === null) {
      return notFound();
    }
    const matches = yield* Result.await(
      Result.tryPromise(async () => await resolveCitedDecisions(lookup)),
    );
    const cited = chooseCitedDecision(matches);
    if (cited === null) {
      return notFound();
    }
    const decision = citationCheckDecision(cited.chosen);
    const alternatives = cited.alternatives.map(citationCheckDecision);

    const row = yield* Result.await(
      Result.tryPromise(
        async () =>
          await caseLawPublicReadDb(
            async (tx) => await readDecisionPassageRow(tx, cited.chosen.id),
          ),
      ),
    );
    // The identity lookup already applied the public and redistribution
    // gates, so a row it returned that this read cannot find is a decision
    // withdrawn between the two statements.
    if (row === null) {
      return notFound();
    }
    // Sources carry different reuse terms. One whose terms withhold derived
    // AI use is resolved and named, but its text never reaches a model.
    if (row.source === null || !allowsDerivedAi(row.source.descriptor)) {
      return unavailable(decision, "derived_ai_withheld");
    }

    const sources = yield* Result.await(
      Result.tryPromise(async () => await rankPassages(row, claim)),
    );
    if (sources.length === 0) {
      return unavailable(decision, "no_text");
    }

    const client = getSystemOneClient();
    if (client === null) {
      return Result.err(
        new HandlerError({
          status: 503,
          message: "Citation checking is not configured on this deployment",
        }),
      );
    }
    const checked = yield* Result.await(
      checkCitationWithSystemOne({
        claim,
        claimLanguage: language ?? row.language,
        client,
        decision: {
          caseNumber: row.caseNumber,
          country: row.country,
          court: row.court,
          decisionDate: decision.decisionDate,
          language: row.language,
        },
        sources,
      }).then((read) =>
        Result.isError(read)
          ? Result.err(
              new HandlerError({
                status: 502,
                message: "The citation check did not complete",
                cause: read.error,
              }),
            )
          : Result.ok(read.value),
      ),
    );

    // The claim is the reader's own prose and never reaches a log line. What
    // is recorded is the reading and what it cost.
    logger.info("case_law.citation_check.system_one", {
      decisionId: row.id,
      model: checked.model,
      inputTokens: checked.inputTokens,
      latencyMs: checked.latencyMs,
      relation: checked.relation,
      probability: checked.probability,
      confidence: checked.confidence,
      passageCount: sources.length,
      alternativeCount: alternatives.length,
    });

    return Result.ok({
      status: "checked",
      decision,
      alternatives,
      ...checked,
    });
  },
);

export default checkCitation;
