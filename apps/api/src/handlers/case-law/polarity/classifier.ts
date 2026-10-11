/**
 * Citation polarity classifier.
 *
 * Orchestrates the classification cascade:
 * 1. Regex rules first (fast, free)
 * 2. A typed decision: the decision model first, with generative fallback
 *    owned by decide; generative evidence supplies promotion phrases
 * 4. Track surface forms for auto-promotion to regex rules
 *
 * Over time, the regex ruleset grows and model usage drops.
 */

import { panic } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawCitations, caseLawPolarityRules } from "@/api/db/schema";
import { runCitationGraphTransaction } from "@/api/handlers/case-law/citation-graph-transaction";
import { classifyCitedPart } from "@/api/handlers/case-law/polarity/cited-part";
import {
  phraseToPattern,
  POLARITY,
  POLARITY_CLASSIFIER_VERSION,
  PROMOTION_THRESHOLD,
  RULE_SOURCE,
} from "@/api/handlers/case-law/polarity/consts";
import type { Polarity } from "@/api/handlers/case-law/polarity/consts";
import type {
  CitationContexts,
  CitationWindows,
} from "@/api/handlers/case-law/polarity/context";
import { POLARITY_READINGS } from "@/api/handlers/case-law/polarity/model-readings";
import { unreviewedCitationSql } from "@/api/handlers/case-law/polarity/reviews";
import {
  incrementMatchCount,
  matchRule,
} from "@/api/handlers/case-law/polarity/rule-engine";
import type {
  RuleCache,
  ValidRuleKindPolarity,
} from "@/api/handlers/case-law/polarity/rule-engine";
import { classifyWithSystemOne } from "@/api/handlers/case-law/polarity/system-one-classifier";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  CitedPart,
  CitationPolaritySource,
} from "@/api/lib/case-law/citation-vocabulary";
import type { CitationTextRevision } from "@/api/lib/case-law/text-revision";
import { citationTextRevisionFence } from "@/api/lib/case-law/text-revision";
import type { DecisionGenerator } from "@/api/lib/workflow/decisions/decide";
import type { SystemOneClient } from "@/api/lib/workflow/decisions/system-one";

export { extractContexts } from "@/api/handlers/case-law/polarity/context";

/** How many of a citation's windows the model tiers read. */
const EXCERPT_WINDOWS = 5;
const MIN_PROMOTION_PHRASE_LENGTH = 3;
const MAX_PROMOTION_PHRASE_LENGTH = 100;

/**
 * What the model tiers read: the citation's windows in reading order, with
 * the cuts marked. A model is asked about the court's stance towards the
 * case, and the stance may be stated at any mention, so it sees several. A
 * case named forty times is bounded to the first two mentions and the last
 * three: the first is where a party's reliance is reported, the last is
 * where the court settles it.
 *
 * One excerpt, one answer: a model tier reads the mentions together and
 * gives the citation a single reading. `mixed` needs each mention read on
 * its own, which only the rule tier does, so it is a verdict that tier
 * reaches (`selectCitationPolarity`) and the model tiers do not.
 */
export const excerptOf = (contexts: CitationContexts): string => {
  if (contexts.length <= EXCERPT_WINDOWS) {
    return contexts.join("\n[…]\n");
  }
  return [...contexts.slice(0, 2), ...contexts.slice(-3)].join("\n[…]\n");
};

type ClassifyResult = {
  polarity: Polarity;
  ruleId: SafeId<"caseLawPolarityRule"> | null;
  source: "regex" | "system-one" | "llm" | "fallback";
  /** Confidence of the deciding tier; null when no tier read the text. */
  confidence: number | null;
  classifierVersion: string;
  windowStart: number;
  windowEnd: number;
  citedPart: CitedPart;
};

/**
 * Classify a single citation's polarity.
 *
 * 1. Match against regex rules
 * 2. If no match, classify with LLM
 * 3. Track the LLM's key phrase for future rule generation
 */
type ClassifyCitationArgs = {
  /** The citation's surroundings in the citing decision (`extractContexts`). */
  windows: CitationWindows;
  citationText: string;
  language: string;
  observedAt: Date;
  scopedDb: ScopedDb;
  options?: {
    abortSignal?: AbortSignal;
    ruleCache?: RuleCache;
    dryRun?: boolean;
    /**
     * The System One tier's client; the instance's when omitted, null to skip
     * the tier. Injected so a comparison run can pin a model.
     */
    decisionModel?: SystemOneClient | null;
    generator?: DecisionGenerator;
  };
};

export const classifyCitation = async ({
  windows,
  citationText,
  language,
  observedAt,
  scopedDb,
  options,
}: ClassifyCitationArgs): Promise<ClassifyResult> => {
  const evidence = {
    classifierVersion: POLARITY_CLASSIFIER_VERSION,
    windowStart: windows.evidenceSpan.start,
    windowEnd: windows.evidenceSpan.end,
    citedPart: classifyCitedPart({
      contexts: windows.contexts,
      citationText,
      language,
    }),
  };
  // Tier 1: regex rules, over the mentions rather than the merged windows,
  // so two mentions that disagree are two readings and not one.
  const ruleMatch = await matchRule(
    windows.mentions,
    language,
    scopedDb,
    options?.ruleCache,
  );

  if (ruleMatch) {
    if (!options?.dryRun) {
      // Fire-and-forget: increment match count
      incrementMatchCount({
        observedAt,
        ruleId: ruleMatch.ruleId,
        scopedDb,
      }).catch((error: unknown) => {
        captureError(error, { ruleId: ruleMatch.ruleId });
      });
    }
    return {
      ...evidence,
      polarity: ruleMatch.polarity,
      ruleId: ruleMatch.ruleId,
      source: "regex",
      confidence: ruleMatch.confidence,
    };
  }

  // The decision owner asks both model tiers over the same excerpt.
  const context = excerptOf(windows.contexts);
  const reading = await classifyWithSystemOne({
    client: options?.decisionModel,
    context,
    citationText,
    language,
    abortSignal: options?.abortSignal,
    generator: options?.generator,
  });
  if (reading.state === "undecided") {
    return {
      ...evidence,
      polarity: POLARITY.UNKNOWN,
      ruleId: null,
      source: "fallback",
      confidence: null,
    };
  }
  const treatment = POLARITY_READINGS[reading.answer.choice];
  const polarity = treatment.polarity;
  const confidence = reading.confidence;
  const keyPhrase = reading.evidence;

  // Track surface form for potential rule promotion
  if (
    !options?.dryRun &&
    reading.source === "generative" &&
    confidence >= 0.8 &&
    keyPhrase !== null &&
    keyPhrase.length >= MIN_PROMOTION_PHRASE_LENGTH &&
    keyPhrase.length <= MAX_PROMOTION_PHRASE_LENGTH &&
    context.includes(keyPhrase) &&
    keyPhrase.trim().length >= MIN_PROMOTION_PHRASE_LENGTH
  ) {
    trackSurfaceForm({
      ...treatment,
      keyPhrase,
      language,
      observedAt,
      scopedDb,
    }).catch((error: unknown) => {
      captureError(error, { language, polarity });
    });
  }

  return {
    ...evidence,
    polarity,
    ruleId: null,
    source: reading.source === "decision-model" ? "system-one" : "llm",
    confidence,
  };
};

/**
 * Track a surface form extracted by the LLM.
 *
 * Uses upsert to avoid race conditions when multiple
 * concurrent classifications produce the same pattern.
 * If the rule already exists, the surface form is appended
 * atomically. Promotion to `llm-promoted` happens when the
 * surface-form count reaches PROMOTION_THRESHOLD.
 */
type TrackSurfaceFormArgs = {
  keyPhrase: string;
  language: string;
  observedAt: Date;
  scopedDb: ScopedDb;
} & ValidRuleKindPolarity;

const trackSurfaceForm = async ({
  kind,
  keyPhrase,
  language,
  observedAt,
  polarity,
  scopedDb,
}: TrackSurfaceFormArgs) => {
  const pattern = phraseToPattern(keyPhrase);
  // Bound below as `::text::jsonb`, never a bare `::jsonb`: the bare cast fixes
  // the parameter's type to jsonb, so the driver JSON-encodes this string again
  // and `@>` compares against a jsonb string instead of the array.
  const formJson = JSON.stringify([keyPhrase]);

  await scopedDb((tx) =>
    // audit: skip — background polarity classification pipeline; no user-facing state change
    tx
      .insert(caseLawPolarityRules)
      .values({
        pattern,
        kind,
        polarity,
        language,
        source: RULE_SOURCE.LLM_PROPOSED,
        confidence: 0,
        surfaceForms: [keyPhrase],
        createdAt: observedAt,
        updatedAt: observedAt,
      })
      .onConflictDoUpdate({
        target: [caseLawPolarityRules.pattern, caseLawPolarityRules.language],
        set: {
          surfaceForms: sql`
          CASE
            WHEN ${caseLawPolarityRules.surfaceForms}
              @> ${formJson}::text::jsonb
            THEN ${caseLawPolarityRules.surfaceForms}
            WHEN ${caseLawPolarityRules.polarity} != ${polarity}
              OR ${caseLawPolarityRules.kind} != ${kind}
            THEN ${caseLawPolarityRules.surfaceForms}
            ELSE ${caseLawPolarityRules.surfaceForms}
              || ${formJson}::text::jsonb
          END
        `,
          source: sql`
          CASE
            WHEN ${caseLawPolarityRules.source} = ${RULE_SOURCE.LLM_PROPOSED}
              AND ${caseLawPolarityRules.polarity} = ${polarity}
              AND ${caseLawPolarityRules.kind} = ${kind}
              AND jsonb_array_length(
                CASE
                  WHEN ${caseLawPolarityRules.surfaceForms}
                    @> ${formJson}::text::jsonb
                  THEN ${caseLawPolarityRules.surfaceForms}
                  ELSE ${caseLawPolarityRules.surfaceForms}
                    || ${formJson}::text::jsonb
                END
              ) >= ${PROMOTION_THRESHOLD}
            THEN ${RULE_SOURCE.LLM_PROMOTED}
            ELSE ${caseLawPolarityRules.source}
          END
        `,
          confidence: sql`
          CASE
            WHEN ${caseLawPolarityRules.source} = ${RULE_SOURCE.LLM_PROPOSED}
              AND ${caseLawPolarityRules.polarity} = ${polarity}
              AND ${caseLawPolarityRules.kind} = ${kind}
              AND jsonb_array_length(
                CASE
                  WHEN ${caseLawPolarityRules.surfaceForms}
                    @> ${formJson}::text::jsonb
                  THEN ${caseLawPolarityRules.surfaceForms}
                  ELSE ${caseLawPolarityRules.surfaceForms}
                    || ${formJson}::text::jsonb
                END
              ) >= ${PROMOTION_THRESHOLD}
            THEN 0.8
            ELSE ${caseLawPolarityRules.confidence}
          END
        `,
          updatedAt: sql`GREATEST(
            ${caseLawPolarityRules.updatedAt},
            ${observedAt}
          )`,
        },
      }),
  );
};

const persistedPolaritySource = (
  source: ClassifyResult["source"],
): CitationPolaritySource | null => {
  switch (source) {
    case "regex":
      return "rule";
    case "system-one":
      return "system-one";
    case "llm":
      return "llm";
    case "fallback":
      return null;
    default: {
      source satisfies never;
      return panic("Unknown polarity classification source");
    }
  }
};

type PersistPolarityArgs = {
  citationId: SafeId<"caseLawCitation">;
  result: ClassifyResult;
  scopedDb: ScopedDb;
  textRevision: CitationTextRevision;
};

/** Persist only against the text revision classified; preserve reviewed rows. */
export const persistPolarity = async ({
  citationId,
  result,
  scopedDb,
  textRevision,
}: PersistPolarityArgs) => {
  const written = await runCitationGraphTransaction(scopedDb, (tx) =>
    // audit: skip — background polarity classification pipeline; no user-facing state change
    tx
      .update(caseLawCitations)
      .set({
        polarity: result.polarity,
        polarityRuleId: result.ruleId,
        polaritySource: persistedPolaritySource(result.source),
        polarityClassifierVersion:
          result.source === "fallback" ? null : result.classifierVersion,
        polarityWindowStart:
          result.source === "fallback" ? null : result.windowStart,
        polarityWindowEnd:
          result.source === "fallback" ? null : result.windowEnd,
        polarityConfidence: result.confidence,
        citedPart: result.citedPart,
      })
      .where(
        and(
          eq(caseLawCitations.id, citationId),
          citationTextRevisionFence({
            citingDecisionId: caseLawCitations.citingDecisionId,
            expectedContentHash: sql`${textRevision.contentHash}::text`,
            expectedSections: sql`${textRevision.sections === null ? null : JSON.stringify(textRevision.sections)}::text::jsonb`,
          }),
          unreviewedCitationSql(caseLawCitations),
        ),
      )
      .returning({ id: caseLawCitations.id }),
  );
  return { applied: written.length, skipped: 1 - written.length };
};
