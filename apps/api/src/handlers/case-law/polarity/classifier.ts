/**
 * Citation polarity classifier.
 *
 * Orchestrates the classification cascade:
 * 1. Regex rules first (fast, free)
 * 2. A System One reading (Jev) when the deployment has a key: a typed
 *    choice with calibrated confidence, accepted above a floor
 * 3. The generative model for what the earlier tiers did not settle; it
 *    also extracts the key phrase a rule can be promoted from
 * 4. Track surface forms for auto-promotion to regex rules
 *
 * Over time, the regex ruleset grows and model usage drops.
 */

import { and, eq, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawCitations, caseLawPolarityRules } from "@/api/db/schema";
import {
  phraseToPattern,
  POLARITY,
  PROMOTION_THRESHOLD,
  RULE_SOURCE,
} from "@/api/handlers/case-law/polarity/consts";
import type { Polarity } from "@/api/handlers/case-law/polarity/consts";
import type {
  CitationContexts,
  CitationWindows,
} from "@/api/handlers/case-law/polarity/context";
import { classifyWithLLM } from "@/api/handlers/case-law/polarity/llm-classifier";
import { unreviewedCitationSql } from "@/api/handlers/case-law/polarity/reviews";
import {
  incrementMatchCount,
  matchRule,
} from "@/api/handlers/case-law/polarity/rule-engine";
import type { RuleCache } from "@/api/handlers/case-law/polarity/rule-engine";
import { classifyWithSystemOne } from "@/api/handlers/case-law/polarity/system-one-classifier";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import type { SystemOneClient } from "@/api/lib/workflow/decisions/system-one";

export { extractContexts } from "@/api/handlers/case-law/polarity/context";

/** How many of a citation's windows the model tiers read. */
const EXCERPT_WINDOWS = 5;

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
  /**
   * How much the deciding tier trusts this label: the rule's stored
   * confidence for a regex match, the model's own for a System One or LLM
   * call, and null on the fallback, where nothing read the text.
   *
   * `case_law_citations` has no column for it yet, so `persistPolarity`
   * drops it and only in-process callers see it.
   */
  confidence: number | null;
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
      polarity: ruleMatch.polarity,
      ruleId: ruleMatch.ruleId,
      source: "regex",
      confidence: ruleMatch.confidence,
    };
  }

  // Tier 2: System One. A decided reading is the label; anything else falls
  // through, including a transport failure and a deployment with no decision
  // model, rather than becoming an `unknown` polarity: the generative tier
  // still reads.
  const context = excerptOf(windows.contexts);
  const reading = await classifyWithSystemOne({
    client: options?.decisionModel,
    context,
    citationText,
    language,
    abortSignal: options?.abortSignal,
  });
  if (reading.state === "decided") {
    return {
      polarity: reading.answer.choice,
      ruleId: null,
      source: "system-one",
      confidence: reading.confidence,
    };
  }

  // Tier 3: LLM classification
  // Note: LLM is called even in dry-run mode (only DB writes
  // are suppressed). Use small --limit values for cost preview.
  const llmResult = await classifyWithLLM({
    context,
    citationText,
    language,
    abortSignal: options?.abortSignal,
  });

  if (llmResult.isErr()) {
    // `unknown` here records that classification did not happen, not that the
    // citation was read and found unclear. The two are not distinguishable
    // once persisted, because the column has no value for "read it, could not
    // decide"; adding one needs a CHECK-constraint migration.
    return {
      polarity: POLARITY.UNKNOWN,
      ruleId: null,
      source: "fallback",
      confidence: null,
    };
  }

  const { polarity, keyPhrase, confidence } = llmResult.value;

  // Track surface form for potential rule promotion
  if (!options?.dryRun && confidence >= 0.8 && keyPhrase.length >= 3) {
    trackSurfaceForm({
      keyPhrase,
      language,
      observedAt,
      polarity,
      scopedDb,
    }).catch((error: unknown) => {
      captureError(error, { language, polarity });
    });
  }

  return { polarity, ruleId: null, source: "llm", confidence };
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
  polarity: Polarity;
  scopedDb: ScopedDb;
};

const trackSurfaceForm = async ({
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

  // oxlint-disable-next-line arrow-body-style -- block body holds the audit-skip directive that the require-audit-on-mutation rule scans for inside this arrow's body range
  await scopedDb((tx) => {
    // audit: skip — background polarity classification pipeline; no user-facing state change
    return tx
      .insert(caseLawPolarityRules)
      .values({
        pattern,
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
            THEN ${caseLawPolarityRules.surfaceForms}
            ELSE ${caseLawPolarityRules.surfaceForms}
              || ${formJson}::text::jsonb
          END
        `,
          source: sql`
          CASE
            WHEN ${caseLawPolarityRules.source} = ${RULE_SOURCE.LLM_PROPOSED}
              AND ${caseLawPolarityRules.polarity} = ${polarity}
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
      });
  });
};

/**
 * Persist a classification result to the citations table.
 *
 * `result.confidence` is deliberately not written: `case_law_citations` has
 * no column for it. Adding one is a schema change, not a write-path change.
 * A reviewed citation is left as it is.
 */
export const persistPolarity = async (
  citationId: SafeId<"caseLawCitation">,
  result: ClassifyResult,
  scopedDb: ScopedDb,
) => {
  // oxlint-disable-next-line arrow-body-style -- block body holds the audit-skip directive that the require-audit-on-mutation rule scans for inside this arrow's body range
  await scopedDb((tx) => {
    // audit: skip — background polarity classification pipeline; no user-facing state change
    return tx
      .update(caseLawCitations)
      .set({
        polarity: result.polarity,
        polarityRuleId: result.ruleId,
      })
      .where(
        and(
          eq(caseLawCitations.id, citationId),
          unreviewedCitationSql(caseLawCitations),
        ),
      );
  });
};
