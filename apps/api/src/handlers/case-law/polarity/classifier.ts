/**
 * Citation polarity classifier.
 *
 * Orchestrates the two-tier classification pipeline:
 * 1. Try regex rules first (fast, free)
 * 2. Fall back to LLM classification
 * 3. Track surface forms for auto-promotion to regex rules
 *
 * Over time, the regex ruleset grows and LLM usage drops.
 */

import { eq, sql } from "drizzle-orm";

import { db } from "@/api/db";
import { caseLawCitations, caseLawPolarityRules } from "@/api/db/schema";
import {
  phraseToPattern,
  POLARITY,
  PROMOTION_THRESHOLD,
  RULE_SOURCE,
  type Polarity,
} from "@/api/handlers/case-law/polarity/consts";
import { classifyWithLLM } from "@/api/handlers/case-law/polarity/llm-classifier";
import {
  incrementMatchCount,
  matchRule,
  type RuleCache,
} from "@/api/handlers/case-law/polarity/rule-engine";

// biome-ignore lint/performance/noBarrelFile: re-export for public API
export { extractContext } from "@/api/handlers/case-law/polarity/context";

export type ClassifyResult = {
  polarity: Polarity;
  ruleId: string | null;
  source: "regex" | "llm" | "fallback";
};

/**
 * Classify a single citation's polarity.
 *
 * 1. Match against regex rules
 * 2. If no match, classify with LLM
 * 3. Track the LLM's key phrase for future rule generation
 */
export const classifyCitation = async (
  context: string,
  citationText: string,
  language: string,
  options?: {
    abortSignal?: AbortSignal;
    ruleCache?: RuleCache;
    dryRun?: boolean;
  },
): Promise<ClassifyResult> => {
  // Tier 1: regex rules
  const ruleMatch = await matchRule(context, language, options?.ruleCache);

  if (ruleMatch) {
    if (!options?.dryRun) {
      // Fire-and-forget: increment match count
      incrementMatchCount(ruleMatch.ruleId).catch((err) => {
        // biome-ignore lint/suspicious/noConsole: fire-and-forget logging
        console.error("[polarity] incrementMatchCount failed:", err);
      });
    }
    return {
      polarity: ruleMatch.polarity,
      ruleId: ruleMatch.ruleId,
      source: "regex",
    };
  }

  // Tier 2: LLM classification
  // Note: LLM is called even in dry-run mode (only DB writes
  // are suppressed). Use small --limit values for cost preview.
  const llmResult = await classifyWithLLM(
    context,
    citationText,
    language,
    options?.abortSignal,
  );

  if (llmResult.isErr()) {
    return {
      polarity: POLARITY.UNKNOWN,
      ruleId: null,
      source: "fallback",
    };
  }

  const { polarity, keyPhrase, confidence } = llmResult.value;

  // Track surface form for potential rule promotion
  if (!options?.dryRun && confidence >= 0.8 && keyPhrase.length >= 3) {
    trackSurfaceForm(keyPhrase, polarity, language).catch((err) => {
      // biome-ignore lint/suspicious/noConsole: fire-and-forget logging
      console.error("[polarity] trackSurfaceForm failed:", err);
    });
  }

  return { polarity, ruleId: null, source: "llm" };
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
const trackSurfaceForm = async (
  keyPhrase: string,
  polarity: Polarity,
  language: string,
) => {
  const pattern = phraseToPattern(keyPhrase);
  const formJson = JSON.stringify([keyPhrase]);

  await db
    .insert(caseLawPolarityRules)
    .values({
      pattern,
      polarity,
      language,
      source: RULE_SOURCE.LLM_PROPOSED,
      confidence: 0,
      surfaceForms: [keyPhrase],
    })
    .onConflictDoUpdate({
      target: [caseLawPolarityRules.pattern, caseLawPolarityRules.language],
      set: {
        surfaceForms: sql`
          CASE
            WHEN ${caseLawPolarityRules.surfaceForms}
              @> ${formJson}::jsonb
            THEN ${caseLawPolarityRules.surfaceForms}
            WHEN ${caseLawPolarityRules.polarity} != ${polarity}
            THEN ${caseLawPolarityRules.surfaceForms}
            ELSE ${caseLawPolarityRules.surfaceForms}
              || ${formJson}::jsonb
          END
        `,
        source: sql`
          CASE
            WHEN ${caseLawPolarityRules.source} = ${RULE_SOURCE.LLM_PROPOSED}
              AND ${caseLawPolarityRules.polarity} = ${polarity}
              AND jsonb_array_length(
                CASE
                  WHEN ${caseLawPolarityRules.surfaceForms}
                    @> ${formJson}::jsonb
                  THEN ${caseLawPolarityRules.surfaceForms}
                  ELSE ${caseLawPolarityRules.surfaceForms}
                    || ${formJson}::jsonb
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
                    @> ${formJson}::jsonb
                  THEN ${caseLawPolarityRules.surfaceForms}
                  ELSE ${caseLawPolarityRules.surfaceForms}
                    || ${formJson}::jsonb
                END
              ) >= ${PROMOTION_THRESHOLD}
            THEN 0.8
            ELSE ${caseLawPolarityRules.confidence}
          END
        `,
        updatedAt: new Date(),
      },
    });
};

/**
 * Persist a classification result to the citations table.
 */
export const persistPolarity = async (
  citationId: string,
  result: ClassifyResult,
) => {
  await db
    .update(caseLawCitations)
    .set({
      polarity: result.polarity,
      polarityRuleId: result.ruleId,
    })
    .where(eq(caseLawCitations.id, citationId));
};
