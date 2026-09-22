/**
 * Batch classify citation polarity.
 *
 * The default pass reads citations with `polarity IS NULL`, newest first:
 * regex rules first (free, fast), then the model tiers for what the rules
 * did not settle.
 *
 * `--recheck` reads citations that already carry a label and asks the rule
 * tier again, keeping the answer only where it is more severe than the label
 * on the row. Adding a negative cue to the seed changes nothing for rows
 * labelled before it existed, since every other pass selects on NULL, and a
 * rule set that only ever tightens is what makes rechecking safe: a verdict
 * can move towards negative on the strength of a rule, never away from it.
 * The pass is regex-only and cheap per row, so it is what an operator runs
 * after seeding new negative rules.
 *
 * Usage:
 *   bun apps/api/scripts/classify-citations.ts [--limit N] [--language cs]
 *   bun apps/api/scripts/classify-citations.ts --recheck --language cs [--limit N] [--after ID]
 *
 * Options:
 *   --limit N      Max citations to process (default: 1000)
 *   --language cs  Only process citations in this language; required with
 *                  --recheck, which walks a language's rules
 *   --seed         Seed initial polarity rules before classifying
 *   --dry-run      Classify but don't persist results
 *   --ids FILE     Only the citation ids in FILE (a JSON array), all of them:
 *                  the set `seed-polarity-rules.ts` writes when it retires a
 *                  rule. Overrides --limit.
 *   --recheck      Re-read labelled rows against the rule tier (see above)
 *   --after ID     With --recheck: resume the id-ordered walk after this id;
 *                  the run prints the id to resume from
 *
 * Idempotent: the default pass only processes citations with NULL polarity,
 * and a recheck writes only where the label changes.
 */

import { panic } from "better-result";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  sql,
} from "drizzle-orm";

import { rootDb, rlsDb } from "@/api/db/root";
import {
  caseLawCitations,
  caseLawDecisions,
  caseLawPolarityRules,
} from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { CITATION_KIND } from "@/api/handlers/case-law/citation-kind";
import {
  classifyCitation,
  extractContexts,
  persistPolarity,
} from "@/api/handlers/case-law/polarity/classifier";
import {
  POLARITY,
  POLARITY_PRECEDENCE,
  RULE_SOURCE,
  isValidPolarity,
} from "@/api/handlers/case-law/polarity/consts";
import type { Polarity } from "@/api/handlers/case-law/polarity/consts";
import {
  loadRules,
  selectCitationPolarity,
} from "@/api/handlers/case-law/polarity/rule-engine";
import type {
  CompiledRule,
  RuleCache,
} from "@/api/handlers/case-law/polarity/rule-engine";
import { SEED_RULES } from "@/api/handlers/case-law/polarity/seed-rules";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";

type Args = {
  limit: number;
  language: string | null;
  seed: boolean;
  dryRun: boolean;
  idsFile: string | null;
  recheck: boolean;
  after: string | null;
};

const parseArgs = (): Args => {
  const args = process.argv.slice(2);
  const result: Args = {
    limit: 1000,
    language: null,
    seed: false,
    dryRun: false,
    idsFile: null,
    recheck: false,
    after: null,
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
    } else if (args[i] === "--recheck") {
      result.recheck = true;
    } else if (args[i] === "--after") {
      if (!next) {
        console.error("Missing citation id after --after");
        process.exit(1);
      }
      result.after = next;
      i++;
    } else if (args[i] === "--ids") {
      // Without the file the run would fall back to the newest unclassified
      // rows and classify the wrong set: refuse rather than guess.
      if (!next) {
        console.error("Missing file path after --ids");
        process.exit(1);
      }
      result.idsFile = next;
      i++;
    }
  }

  if (result.recheck && result.language === null) {
    console.error("--recheck needs --language: the rule tier is per language");
    process.exit(1);
  }
  if (result.recheck && result.idsFile !== null) {
    console.error("--recheck walks a language; it does not take --ids");
    process.exit(1);
  }

  return result;
};

/** The ids a retirement wrote; anything but a list of ids is a wrong file. */
const readIdsFile = async (
  path: string,
): Promise<SafeId<"caseLawCitation">[]> => {
  const raw: unknown = await Bun.file(path).json();
  if (!Array.isArray(raw) || !raw.every((id) => typeof id === "string")) {
    console.error(`Expected a JSON array of citation ids in ${path}`);
    process.exit(1);
  }
  return raw.map((id) => toSafeId<"caseLawCitation">(id));
};

const seedRules = async () => {
  console.log(`Seeding ${SEED_RULES.length} polarity rules...`);

  for (const rule of SEED_RULES) {
    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- constant seed list
    await rootDb
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

const scriptUserId = toSafeId<"user">("script_case_law");
// SAFETY: CLI script operates on global case law data (no tenant).
const scopedDb = createScopedDb(
  rlsDb,
  [],
  toSafeId<"organization">(""),
  scriptUserId,
);

/** Rows read per statement on a recheck walk. */
const RECHECK_BATCH = 1000;

type Tightened = {
  id: SafeId<"caseLawCitation">;
  polarity: Polarity;
  ruleId: SafeId<"caseLawPolarityRule">;
};

/** One statement per page: the tightened rows take their new verdicts. */
const persistTightened = async (rows: readonly Tightened[]) => {
  if (rows.length === 0) {
    return;
  }
  await scopedDb(async (tx) => {
    // audit: skip — background polarity classification pipeline; no user-facing state change
    await tx.execute(sql`
      UPDATE ${caseLawCitations} AS c
         SET polarity = v.polarity,
             polarity_rule_id = v.rule_id
        FROM (VALUES ${sql.join(
          rows.map(
            (row) =>
              sql`(${row.id}::uuid, ${row.polarity}::text, ${row.ruleId}::uuid)`,
          ),
          sql.raw(","),
        )}) AS v(id, polarity, rule_id)
       WHERE c.id = v.id
    `);
  });
};

type RecheckTotals = { read: number; tightened: number; noContext: number };

type RecheckPageArgs = {
  args: Args;
  language: string;
  rules: readonly CompiledRule[];
  after: string | null;
  totals: RecheckTotals;
};

/**
 * One page of the walk, then the next: a page is read, its verdicts are
 * settled in one statement, and the walk recurses from the page's last id
 * until the limit or the end of the language. Recursion rather than a loop
 * so each page's read and write are the page's own awaits, and a crash
 * between pages keeps every page already written.
 */
const recheckPage = async ({
  args,
  language,
  rules,
  after,
  totals,
}: RecheckPageArgs): Promise<{
  after: string | null;
  totals: RecheckTotals;
}> => {
  // The rows the pipeline would label: invoked authority, in this language,
  // not already at the severity nothing outranks. `unknown` rows are in:
  // the model tiers failed on them, no other pass revisits them, and a rule
  // reading them now is a label they never had.
  const conditions = [
    eq(caseLawDecisions.language, language),
    eq(caseLawCitations.kind, CITATION_KIND.PRECEDENT),
    isNotNull(caseLawCitations.polarity),
    ne(caseLawCitations.polarity, POLARITY.NEGATIVE),
  ];
  if (after !== null) {
    conditions.push(
      gt(caseLawCitations.id, toSafeId<"caseLawCitation">(after)),
    );
  }
  const pageSize = Math.min(RECHECK_BATCH, args.limit - totals.read);
  const page = await rootDb
    .select({
      id: caseLawCitations.id,
      citationText: caseLawCitations.citationText,
      sectionIndex: caseLawCitations.sectionIndex,
      polarity: caseLawCitations.polarity,
      sections: caseLawDecisions.sections,
    })
    .from(caseLawCitations)
    .innerJoin(
      caseLawDecisions,
      eq(caseLawDecisions.id, caseLawCitations.citingDecisionId),
    )
    .where(and(...conditions))
    .orderBy(asc(caseLawCitations.id))
    .limit(pageSize);
  if (page.length === 0) {
    return { after: null, totals };
  }

  const tightened: Tightened[] = [];
  let noContext = 0;
  for (const citation of page) {
    const windows = extractContexts(
      citation.sections ?? [],
      citation.citationText,
      citation.sectionIndex,
    );
    if (windows === null) {
      noContext++;
      continue;
    }
    const match = selectCitationPolarity(rules, windows.mentions);
    if (match === null) {
      continue;
    }
    const current = citation.polarity;
    if (current === null || !isValidPolarity(current)) {
      // The query selects labelled rows and the column has a CHECK
      // constraint; a null or a value outside it is a broken row, not a
      // case to skip.
      panic("citation carries a polarity outside the column's values", {
        citationId: citation.id,
        polarity: current,
      });
    }
    if (POLARITY_PRECEDENCE[match.polarity] >= POLARITY_PRECEDENCE[current]) {
      continue;
    }
    tightened.push({
      id: citation.id,
      polarity: match.polarity,
      ruleId: match.ruleId,
    });
  }
  if (!args.dryRun) {
    await persistTightened(tightened);
  }

  const last = page.at(-1)?.id ?? after;
  const next = {
    read: totals.read + page.length,
    tightened: totals.tightened + tightened.length,
    noContext: totals.noContext + noContext,
  };
  if (page.length < pageSize) {
    return { after: null, totals: next };
  }
  if (next.read >= args.limit) {
    return { after: last, totals: next };
  }
  return await recheckPage({
    args,
    language,
    rules,
    after: last,
    totals: next,
  });
};

/**
 * Walk a language's labelled rows in id order and tighten the label where the
 * rules now read something more severe. Rows already negative are skipped in
 * the query: nothing outranks negative, so the rules cannot move them.
 */
const recheck = async (args: Args, language: string) => {
  const ruleCache: RuleCache = new Map();
  const rules = await loadRules(language, scopedDb, ruleCache);
  console.log(
    `Rechecking up to ${args.limit} labelled ${language} citations against ${rules.length} rules...`,
  );

  const { after, totals } = await recheckPage({
    args,
    language,
    rules,
    after: args.after,
    totals: { read: 0, tightened: 0, noContext: 0 },
  });

  console.log("\nResults:");
  console.log(`  Read:        ${totals.read}`);
  console.log(`  Tightened:   ${totals.tightened}`);
  console.log(`  No context:  ${totals.noContext}`);
  if (after === null) {
    console.log("  Walk complete.");
  } else {
    console.log(`  Resume with: --after ${after}`);
  }
  if (args.dryRun) {
    console.log("\n(dry run — no changes persisted)");
  }
};

const main = async () => {
  const args = parseArgs();

  if (args.seed) {
    await seedRules();
  }

  if (args.recheck && args.language !== null) {
    await recheck(args, args.language);
    process.exit(0);
  }

  const conditions = [isNull(caseLawCitations.polarity)];
  if (args.language) {
    conditions.push(eq(caseLawDecisions.language, args.language));
  }
  const onlyIds =
    args.idsFile === null ? null : await readIdsFile(args.idsFile);
  if (onlyIds !== null) {
    conditions.push(inArray(caseLawCitations.id, onlyIds));
  }
  const limit = onlyIds === null ? args.limit : onlyIds.length;

  // Fetch unclassified citations with their decision context
  const citations = await rootDb
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
    .limit(limit);

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
    const windows = extractContexts(
      citation.sections ?? [],
      citation.citationText,
      citation.sectionIndex,
    );

    if (windows === null) {
      noContext++;
      continue;
    }

    try {
      // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- rules load once into the caller-owned cache; the model tier is rate-limited
      const result = await classifyCitation({
        windows,
        citationText: citation.citationText,
        language: citation.language,
        observedAt: new Date(),
        scopedDb,
        options: { ruleCache, dryRun: args.dryRun },
      });

      if (result.source === "regex") {
        regexMatches++;
      } else if (result.source === "llm") {
        llmClassified++;
      } else {
        fallbacks++;
      }

      if (!args.dryRun && result.source !== "fallback") {
        // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- each classification is persisted before the next model call, so a crash keeps finished work
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
