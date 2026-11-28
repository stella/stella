/**
 * Checking one sentence against the decision it cites.
 *
 * The reference is resolved against the public corpus the way the search box
 * and the citator resolve one, so a citation that names no decision here is
 * answered as such rather than judged. When it does resolve, the decision's
 * passages go to the decision model, which says how the court stands to the
 * sentence and which passage the reading rests on.
 *
 * No generative model runs on this path. The finding is a choice among three
 * relations and one of the passages the request offered, so what comes back
 * is the court's own text and a calibrated reading, never prose about the
 * decision.
 *
 * Off unless the deployment enables `FEATURE_CITATION_CHECK` and an operator
 * grants the organization the `citation-check` feature (both gates sit on the
 * route). A deployment or organization without a decision model is refused
 * before any corpus read.
 */

import { panic, Result } from "better-result";
import * as v from "valibot";

import { AI_FAILURE_CODES } from "@stll/api-contract";
import { exactDecisionMatches } from "@stll/api-contract/decision-query-intent";

import { checkCitationDecision } from "@/api/handlers/case-law/citations/check-decision";
import {
  chooseCitedDecision,
  citationCheckDecision,
  readCitedDecision,
} from "@/api/handlers/case-law/citations/check.logic";
import type {
  CitationCheckDecision,
  CitationReading,
  CitedDecisionRead,
} from "@/api/handlers/case-law/citations/check.logic";
import {
  decisionIdentityLocatorOf,
  lookupDecisionsByIdentities,
} from "@/api/handlers/case-law/decisions/lookup-by-identity";
import type { DecisionIdentityRow } from "@/api/handlers/case-law/decisions/lookup-by-identity";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import type { OrgAIConfigStatus } from "@/api/lib/ai-config-loader-core";
import { storedAIConfigUnreadableError } from "@/api/lib/ai-config-response";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type {
  HandlerConfig,
  SafeHandlerGenerator,
} from "@/api/lib/api-handlers";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import {
  readResearchDecision,
  resolveDecisionText,
} from "@/api/lib/case-law/research-answer-runner";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { CITATION_CHECK_FEATURE_ID } from "@/api/lib/feature-access/registry";
import { allowsDerivedAi } from "@/api/lib/legal-search/corpus-source";
import { LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";
import { SYSTEM_ONE_SOURCE_BUDGET_CHARS } from "@/api/lib/workflow/decisions/answer-questions";
import type { AnswerSource } from "@/api/lib/workflow/decisions/answer-questions";
import { hasCustomerDecisionModel } from "@/api/lib/workflow/decisions/decision-model";
import type { DecisionModel } from "@/api/lib/workflow/decisions/decision-model";

/**
 * Why a resolved decision could not be checked. Both are properties of the
 * decision rather than of the request: a source whose terms withhold derived
 * AI use is resolved and named but never sent to a model, and a row the
 * corpus lists without holding its text has nothing to read.
 */
type CitationCheckUnavailableReason = "derived_ai_withheld" | "no_text";

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
    } & CitationReading);

const notFound = (): Result<CitationCheckResponse, never> =>
  Result.ok({ status: "not_found" });

const unavailable = (
  decision: CitationCheckDecision,
  reason: CitationCheckUnavailableReason,
): Result<CitationCheckResponse, never> =>
  Result.ok({ status: "unavailable", decision, reason });

// Answered like every other AI feature without a configured model: the
// organization (or the deployment) has to configure one, so it is the
// caller's to fix, not a server failure.
const decisionModelMissing = () =>
  new HandlerError({
    code: AI_FAILURE_CODES.role_not_configured,
    status: 403,
    message:
      "Citation checks need a decision model, and none is configured " +
      "for this caller.",
  });

/**
 * Whether a check may start, decided from the request context alone: an
 * unreadable AI configuration or no decision model the organization may use
 * refuses before the corpus is read.
 */
export const citationCheckAdmission = ({
  orgAIConfig,
  orgAIConfigStatus,
  hasDecisionModel = hasCustomerDecisionModel,
}: {
  orgAIConfig: OrgAIConfig | null;
  orgAIConfigStatus: OrgAIConfigStatus;
  hasDecisionModel?: typeof hasCustomerDecisionModel;
}): Result<void, HandlerError> => {
  if (orgAIConfigStatus === ORG_AI_CONFIG_STATUS.unreadable) {
    return Result.err(storedAIConfigUnreadableError());
  }
  return hasDecisionModel(orgAIConfig)
    ? Result.ok(undefined)
    : Result.err(decisionModelMissing());
};

/**
 * The decisions that answer to the reference, across every jurisdiction whose
 * grammar claims it, in one read. A row counts only when the reference is one
 * of the names the decision answers to itself, under the reading of the
 * decision's own jurisdiction.
 */
const resolveCitedDecisions = async (
  caseLawDb: CaseLawPublicReadDb,
  [first, ...rest]: readonly [CitedDecisionRead, ...CitedDecisionRead[]],
): Promise<DecisionIdentityRow[]> => {
  const reads = [first, ...rest];
  const rows = await lookupDecisionsByIdentities({
    caseLawDb,
    reads: [
      {
        country: first.country,
        locator: decisionIdentityLocatorOf(first.intent),
      },
      ...rest.map(({ country, intent }) => ({
        country,
        locator: decisionIdentityLocatorOf(intent),
      })),
    ],
  });
  return reads.flatMap(({ country, intent }) =>
    exactDecisionMatches(
      intent,
      rows.filter((row) => row.country === country),
    ),
  );
};

const config = {
  contract: "patch",
  description:
    "Check one sentence against the court decision it cites. Resolves the " +
    "reference against the public case-law corpus and asks the decision " +
    "model whether the decision supports, contradicts or does not address " +
    "the sentence, with the passage the reading rests on. Answers not_found " +
    "when no decision here answers to the reference, and unavailable when " +
    "the decision's source withholds derived AI use or it has no readable " +
    "text. Stores nothing.",
  // The grant an in-app AI affordance carries: a member who may read a matter
  // and spend the organization's AI on it.
  permissions: { workspace: ["read"], chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  featureAccess: { featureId: CITATION_CHECK_FEATURE_ID, type: "required" },
  // A document-editor affordance. An agent reaches the same corpus through
  // the case-law tools and forms its own view.
  mcp: { type: "internal", reason: "search_ui" },
  access: "read",
  body: v.object({
    /** A decision reference as prose writes it, prefix and sheet included. */
    citation: v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(LIMITS.caseLawIdentifierMaxLength),
    ),
    /** The sentence the decision is cited for, in any language. */
    claim: v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(LIMITS.caseLawCitationCheckClaimChars),
    ),
  }),
  requiresUsage: { actionType: "case_law", serviceTier: "standard" },
  aggregateMutation: {
    type: "independent",
    reason:
      "Reads the public corpus and asks the decision model; writes only its own usage rows, with no cross-row invariant.",
  },
} satisfies HandlerConfig;

type CheckCitationDependencies = {
  /** Test seam; the public corpus reader otherwise. */
  caseLawDb?: CaseLawPublicReadDb;
  hasDecisionModel?: typeof hasCustomerDecisionModel;
  /** Test seam; the organization's resolved decision model otherwise. */
  decisionModel?: DecisionModel;
};

export const createCheckCitation = ({
  caseLawDb = caseLawPublicReadDb,
  hasDecisionModel = hasCustomerDecisionModel,
  decisionModel,
}: CheckCitationDependencies = {}) =>
  createSafeRootHandler(
    config,
    async function* ({
      body: { citation, claim },
      orgAIConfig,
      orgAIConfigStatus,
      safeDb,
      session,
      user,
    }): SafeHandlerGenerator<CitationCheckResponse> {
      yield* citationCheckAdmission({
        orgAIConfig,
        orgAIConfigStatus,
        hasDecisionModel,
      });

      // Each stage leaves one line, so an operator can follow a check from
      // the reference read out of the prose to the reading that came back.
      // The claim itself never appears in any of them.
      const startedAt = performance.now();
      const reads = readCitedDecision(citation);
      logger.info("case_law.citation_check.reference", {
        recognized: reads.length > 0,
        countries: reads.map((read) => read.country).join(","),
      });
      const [firstRead, ...otherReads] = reads;
      if (firstRead === undefined) {
        return notFound();
      }
      const matches = yield* Result.await(
        Result.tryPromise(
          async () =>
            await resolveCitedDecisions(caseLawDb, [firstRead, ...otherReads]),
        ),
      );
      const cited = chooseCitedDecision(matches);
      logger.info("case_law.citation_check.lookup", {
        matchCount: matches.length,
        found: cited !== null,
        decisionId: cited?.chosen.id ?? "",
      });
      if (cited === null) {
        return notFound();
      }
      const decision = citationCheckDecision(cited.chosen);
      const alternatives = cited.alternatives.map(citationCheckDecision);

      const row = yield* Result.await(
        Result.tryPromise(
          async () =>
            await caseLawDb(
              async (tx) => await readResearchDecision(tx, cited.chosen.id),
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

      // Whole and in reading order when it fits the budget, which a judgment
      // usually does; only a longer decision is cut to the passages the
      // corpus index ranks against the claim.
      const text = yield* Result.await(
        Result.tryPromise(
          async () =>
            await resolveDecisionText(
              row,
              [{ question: claim }],
              caseLawDb,
              SYSTEM_ONE_SOURCE_BUDGET_CHARS,
            ),
        ),
      );
      const sources: AnswerSource[] =
        text.kind === "none"
          ? []
          : text.passages.map((passage) => ({
              id: passage.anchorId,
              text: passage.excerpt,
            }));
      if (sources.length === 0) {
        return unavailable(decision, "no_text");
      }

      const checked = await checkCitationDecision({
        orgAIConfig,
        claim,
        // The editor knows the reader's locale, not the language of the
        // document, so the claim is read in the decision's language.
        claimLanguage: row.language,
        decision: {
          caseNumber: row.caseNumber,
          country: row.country,
          court: row.court,
          decisionDate: decision.decisionDate,
          language: row.language,
        },
        sources,
        client: decisionModel,
        usageMetering: {
          actionType: "case_law",
          serviceTier: "standard",
          organizationId: session.activeOrganizationId,
          userId: user.id,
          workspaceId: null,
          safeDb,
          callId: Bun.randomUUIDv7(),
        },
      });
      // The claim is the member's own prose and never reaches a log line;
      // the decision log records the reading and what it cost.
      logger.info("case_law.citation_check.decided", {
        decisionId: row.id,
        model: checked.model ?? "",
        outcome:
          checked.result.type === "read"
            ? checked.result.reading.relation
            : checked.result.reason,
        passageCount: sources.length,
        alternativeCount: alternatives.length,
        totalMs: Math.round(performance.now() - startedAt),
      });
      switch (checked.result.type) {
        case "read":
          return Result.ok({
            status: "checked",
            decision,
            alternatives,
            relation: checked.result.reading.relation,
            probability: checked.result.reading.probability,
            confidence: checked.result.reading.confidence,
            passage: checked.result.reading.passage,
          });
        case "failed":
          return Result.err(
            checked.result.reason === "no_model"
              ? decisionModelMissing()
              : new HandlerError({
                  // The decision layer already reported the provider failure.
                  code: "upstream_unavailable",
                  status: 502,
                  message: "The citation check did not complete",
                }),
          );
        default:
          checked.result satisfies never;
          return panic("Unhandled citation check result");
      }
    },
  );

const checkCitation = createCheckCitation();

export default checkCitation;
