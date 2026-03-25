/**
 * Batch classify citation polarity for unclassified citations.
 *
 * Processes citations with `polarity IS NULL` in batches.
 * Uses regex rules first (free, fast), falls back to LLM
 * for unmatched citations.
 *
 * Usage:
 *   bun apps/api/scripts/classify-citations.ts [--limit N] [--language cs]
 *
 * Options:
 *   --limit N      Max citations to process (default: 1000)
 *   --language cs  Only process citations in this language
 *   --seed         Seed initial polarity rules before classifying
 *   --dry-run      Classify but don't persist results
 *
 * Idempotent: only processes citations with NULL polarity.
 */

import { and, desc, eq, isNull } from "drizzle-orm";

import { createScopedDb, db } from "@/api/db";
import {
  caseLawCitations,
  caseLawDecisions,
  caseLawPolarityRules,
} from "@/api/db/schema";
import {
  classifyCitation,
  extractContext,
  persistPolarity,
} from "@/api/handlers/case-law/polarity/classifier";
import { RULE_SOURCE } from "@/api/handlers/case-law/polarity/consts";
import type { RuleCache } from "@/api/handlers/case-law/polarity/rule-engine";
import { SEED_RULES } from "@/api/handlers/case-law/polarity/seed-rules";
import { toSafeId } from "@/api/lib/branded-types";

type Args = {
  limit: number;
  language: string | null;
  seed: boolean;
  dryRun: boolean;
};

const parseArgs = (): Args => {
  const args = process.argv.slice(2);
  const result: Args = {
    limit: 1000,
    language: null,
    seed: false,
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    const next = args[i + 1];
    if (args[i] === "--limit" && next) {
      result.limit = Number.parseInt(next, 10);
      if (Number.isNaN(result.limit)) {
        console.error(`Invalid --limit value: "${next}"`);
        process.exit(1);
      }
      i++;
    } else if (args[i] === "--language" && next) {
      result.language = next;
      i++;
    } else if (args[i] === "--seed") {
      result.seed = true;
    } else if (args[i] === "--dry-run") {
      result.dryRun = true;
    }
  }

  return result;
};

const seedRules = async () => {
  console.log(`Seeding ${SEED_RULES.length} polarity rules...`);

  for (const rule of SEED_RULES) {
    await db
      .insert(caseLawPolarityRules)
      .values({
        pattern: rule.pattern,
        polarity: rule.polarity,
        language: rule.language,
        source: RULE_SOURCE.MANUAL,
        confidence: 1,
      })
      .onConflictDoNothing();
  }

  console.log("Seed rules applied.");
};

const main = async () => {
  const args = parseArgs();
  // SAFETY: CLI script operates on global case law data (no tenant).
  const scopedDb = createScopedDb(db, [], toSafeId<"organization">(""));

  if (args.seed) {
    await seedRules();
  }

  const conditions = [isNull(caseLawCitations.polarity)];
  if (args.language) {
    conditions.push(eq(caseLawDecisions.language, args.language));
  }

  // Fetch unclassified citations with their decision context
  const citations = await db
    .select({
      id: caseLawCitations.id,
      citationText: caseLawCitations.citationText,
      sectionIndex: caseLawCitations.sectionIndex,
      language: caseLawDecisions.language,
      sections: caseLawDecisions.sections,
    })
    .from(caseLawCitations)
    .innerJoin(
      caseLawDecisions,
      eq(caseLawDecisions.id, caseLawCitations.citingDecisionId),
    )
    .where(and(...conditions))
    .orderBy(desc(caseLawCitations.createdAt))
    .limit(args.limit);

  if (citations.length === 0) {
    console.log("No unclassified citations found.");
    process.exit(0);
  }

  console.log(`Processing ${citations.length} citations...`);

  // Caller-owned cache: avoids reloading rules per citation
  // within this batch run while keeping the API stateless.
  const ruleCache: RuleCache = new Map();

  let regexMatches = 0;
  let llmClassified = 0;
  let fallbacks = 0;
  let noContext = 0;

  for (const citation of citations) {
    const sections = citation.sections ?? [];

    const context = extractContext(
      sections,
      citation.citationText,
      citation.sectionIndex,
    );

    if (!context) {
      noContext++;
      continue;
    }

    try {
      const result = await classifyCitation(
        context,
        citation.citationText,
        citation.language,
        scopedDb,
        { ruleCache, dryRun: args.dryRun },
      );

      if (result.source === "regex") {
        regexMatches++;
      } else if (result.source === "llm") {
        llmClassified++;
      } else {
        fallbacks++;
      }

      if (!args.dryRun && result.source !== "fallback") {
        await persistPolarity(citation.id, result, scopedDb);
      }

      // Rate limit LLM calls
      if (result.source === "llm") {
        await Bun.sleep(200);
      }
    } catch (error) {
      console.error(`[polarity] Failed citation ${citation.id}:`, error);
      fallbacks++;
    }
  }

  console.log("\nResults:");
  console.log(`  Regex matches:  ${regexMatches}`);
  console.log(`  LLM classified: ${llmClassified}`);
  console.log(`  Fallbacks:      ${fallbacks}`);
  console.log(`  No context:     ${noContext}`);
  console.log(`  Total:          ${citations.length}`);

  if (args.dryRun) {
    console.log("\n(dry run — no changes persisted)");
  }

  process.exit(0);
};

main().catch((error: unknown) => {
  console.error("Classification failed:", error);
  process.exit(1);
});
