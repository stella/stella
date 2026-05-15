/**
 * Citation resolver + seed rules + rule-based polarity + report.
 *
 * Steps:
 * 1. Seed polarity rules into DB (idempotent)
 * 2. Normalize citation text → extract bare case number or ECLI
 * 3. Match against case_law_decisions by case_number or ecli
 * 4. Update citedDecisionId for resolved citations
 * 5. Run rule-based polarity on resolved citations
 * 6. Print report: resolved, ambiguous, unresolved
 *
 * Usage:
 *   bun apps/api/src/scripts/resolve-citations.ts
 *   bun apps/api/src/scripts/resolve-citations.ts --dry-run
 *   bun apps/api/src/scripts/resolve-citations.ts --report-only
 */

import { eq, isNull, sql } from "drizzle-orm";

import { db } from "@/api/db/root";
import {
  caseLawCitations,
  caseLawDecisions,
  caseLawPolarityRules,
} from "@/api/db/schema";
import { extractContext } from "@/api/handlers/case-law/polarity/context";
import { SEED_RULES } from "@/api/handlers/case-law/polarity/seed-rules";
import type { SafeId } from "@/api/lib/branded-types";

const BATCH_SIZE = 500;
const DRY_RUN = process.argv.includes("--dry-run");
const REPORT_ONLY = process.argv.includes("--report-only");

const formatSqlValue = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  if (
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }

  if (value === null || value === undefined) {
    return "";
  }

  return JSON.stringify(value) ?? "";
};

// ── Citation normalization ──────────────────────────────

/**
 * Extract a bare case number from a citation text.
 * Returns undefined if the format is unrecognized.
 */
const normalizeCitation = (
  text: string,
): { caseNumber?: string; ecli?: string } => {
  const trimmed = text.trim();

  // ECLI — match directly
  if (trimmed.startsWith("ECLI:")) {
    return { ecli: trimmed };
  }

  // Czech: "sp. zn. 33 Cdo 2178/2018" → "33 Cdo 2178/2018"
  const spZn = /^sp\.\s*zn\.\s*(.+)/i.exec(trimmed);
  if (spZn?.[1]) {
    return { caseNumber: spZn[1].trim() };
  }

  // Czech file number: "č. j. 5 As 123/2020" → "5 As 123/2020"
  const cj = /^[čc]\.\s*j\.\s*(.+)/i.exec(trimmed);
  if (cj?.[1]) {
    return { caseNumber: cj[1].trim() };
  }

  // Czech collection: "č. 123/2020 Sb. rozh. tr." — no case number
  if (/^[čc]\.\s*\d+\/\d+\s+Sb\./.test(trimmed)) {
    return {};
  }

  // Polish: "sygn. akt II CSK 123/20" → "II CSK 123/20"
  const sygn = /^sygn\.\s*(?:akt\s+)?(.+)/i.exec(trimmed);
  if (sygn?.[1]) {
    return { caseNumber: sygn[1].trim() };
  }

  // Polish bare: "II CSK 123/20" — already a case number
  if (/^[IVX]{2,4}\s+[A-Za-z]{2,5}\s+\d/.test(trimmed)) {
    return { caseNumber: trimmed };
  }

  // Slovak: "1Cdo/123/2020" — already a case number
  if (/^\d{1,3}[A-Za-z]+\/\d+\/\d{4}$/.test(trimmed)) {
    return { caseNumber: trimmed };
  }

  return {};
};

// ── Step 1: Seed rules ──────────────────────────────────

const seedRules = async () => {
  console.log("Seeding polarity rules...");

  let upserted = 0;
  for (const rule of SEED_RULES) {
    await db
      .insert(caseLawPolarityRules)
      .values({
        pattern: rule.pattern,
        polarity: rule.polarity,
        language: rule.language,
        source: "manual",
        confidence: 1,
      })
      .onConflictDoUpdate({
        target: [caseLawPolarityRules.pattern, caseLawPolarityRules.language],
        set: { polarity: rule.polarity, confidence: 1 },
      });
    upserted++;
  }
  console.log(`  ${upserted} rules upserted (${SEED_RULES.length} total)`);
};

// ── Temporal validation ────────────────────────────────

/**
 * A cited decision ID where temporal ordering has been verified: the
 * citing decision is on or after the cited decision's date (or where
 * date comparison is impossible because one date is missing).
 * The only way to obtain this type is through `validateTemporalOrder`,
 * making temporally impossible citations a compile error at the update site.
 */
type ValidCitedDecisionId = SafeId<"caseLawDecision"> & {
  readonly __brand: "ValidCitedDecisionId";
};

const validateTemporalOrder = (
  citingDate: string | null,
  citedDate: string | null,
  matchedId: SafeId<"caseLawDecision">,
): ValidCitedDecisionId | null => {
  // If either date is unknown, allow the match (can't validate)
  if (!citingDate || !citedDate) {
    // SAFETY: branded-type constructor — date is missing so we can't disprove temporal order
    // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    return matchedId as ValidCitedDecisionId;
  }
  // ISO dates sort lexicographically; citing must be on or after cited
  if (citingDate >= citedDate) {
    // SAFETY: branded-type constructor — temporal order verified above
    // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    return matchedId as ValidCitedDecisionId;
  }
  return null;
};

// ── Step 2: Resolve citations ───────────────────────────

type ResolveStats = {
  total: number;
  resolved: number;
  ambiguous: number;
  unresolved: number;
  ecliResolved: number;
  selfCitations: number;
  temporalViolations: number;
};

const resolveCitations = async (): Promise<ResolveStats> => {
  const stats: ResolveStats = {
    total: 0,
    resolved: 0,
    ambiguous: 0,
    unresolved: 0,
    ecliResolved: 0,
    selfCitations: 0,
    temporalViolations: 0,
  };

  // Count unresolved
  const [countRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(caseLawCitations)
    .where(isNull(caseLawCitations.citedDecisionId));
  const count = countRow?.count ?? 0;

  stats.total = count;
  console.log(`\nResolving ${count} citations...`);

  // Build a lookup index of case_number → decision_id
  console.log("  Building case number index...");
  const decisions = await db
    .select({
      id: caseLawDecisions.id,
      caseNumber: caseLawDecisions.caseNumber,
      ecli: caseLawDecisions.ecli,
      decisionDate: caseLawDecisions.decisionDate,
    })
    .from(caseLawDecisions);

  // Index by normalized case number (lowercase, trimmed)
  const caseNumberIndex = new Map<string, SafeId<"caseLawDecision">[]>();
  const ecliIndex = new Map<string, SafeId<"caseLawDecision">>();
  const dateIndex = new Map<SafeId<"caseLawDecision">, string | null>();

  for (const d of decisions) {
    const key = d.caseNumber.toLowerCase().trim();
    const existing = caseNumberIndex.get(key);
    if (existing) {
      existing.push(d.id);
    } else {
      caseNumberIndex.set(key, [d.id]);
    }

    if (d.ecli) {
      ecliIndex.set(d.ecli.toLowerCase(), d.id);
    }

    dateIndex.set(d.id, d.decisionDate);
  }

  console.log(
    `  Index: ${caseNumberIndex.size} case numbers, ` +
      `${ecliIndex.size} ECLIs`,
  );

  // Process in batches. Resolved rows drop out of the WHERE clause,
  // so offset only advances by the count of rows that stay unresolved.
  let processed = 0;
  let offset = 0;

  while (true) {
    const batch = await db
      .select({
        id: caseLawCitations.id,
        citingDecisionId: caseLawCitations.citingDecisionId,
        citationText: caseLawCitations.citationText,
      })
      .from(caseLawCitations)
      .where(isNull(caseLawCitations.citedDecisionId))
      .orderBy(caseLawCitations.id)
      .limit(BATCH_SIZE)
      .offset(offset);

    if (batch.length === 0) {
      break;
    }
    let batchResolved = 0;

    for (const row of batch) {
      const normalized = normalizeCitation(row.citationText);

      let matchedId: SafeId<"caseLawDecision"> | undefined;
      let isAmbiguous = false;

      // Try ECLI first (unique)
      let ecliMatch = false;
      if (normalized.ecli) {
        matchedId = ecliIndex.get(normalized.ecli.toLowerCase());
        if (matchedId) {
          ecliMatch = true;
        }
      }

      // Try case number
      if (!matchedId && normalized.caseNumber) {
        const key = normalized.caseNumber.toLowerCase().trim();
        const matches = caseNumberIndex.get(key);

        if (matches) {
          if (matches.length === 1) {
            matchedId = matches[0];
          } else {
            isAmbiguous = true;
            stats.ambiguous++;
          }
        }
      }

      // Skip self-citations (decision citing itself)
      if (matchedId === row.citingDecisionId) {
        stats.selfCitations++;
        processed++;
        continue;
      }

      // Validate temporal ordering before accepting the match
      let validId: ValidCitedDecisionId | null = null;
      let isTemporalViolation = false;
      if (matchedId) {
        validId = validateTemporalOrder(
          dateIndex.get(row.citingDecisionId) ?? null,
          dateIndex.get(matchedId) ?? null,
          matchedId,
        );
        if (!validId) {
          isTemporalViolation = true;
          stats.temporalViolations++;
          matchedId = undefined;
        }
      }

      if (validId && !DRY_RUN) {
        await db
          .update(caseLawCitations)
          .set({ citedDecisionId: validId })
          .where(eq(caseLawCitations.id, row.id));
        batchResolved++;
      }

      if (validId) {
        stats.resolved++;
        if (ecliMatch) {
          stats.ecliResolved++;
        }
      } else if (!isAmbiguous && !isTemporalViolation) {
        stats.unresolved++;
      }

      processed++;
      if (processed % 10_000 === 0) {
        console.log(
          `  ${processed}/${count} ` +
            `(${stats.resolved} resolved, ${stats.ambiguous} ambiguous, ` +
            `${stats.unresolved} unresolved)`,
        );
      }
    }

    // Resolved rows dropped from the result set; only advance
    // past rows that remain (unresolved, self, ambiguous, temporal).
    offset += batch.length - batchResolved;

    if (REPORT_ONLY) {
      break;
    }
  }

  return stats;
};

// ── Step 3: Rule-based polarity ─────────────────────────

const classifyWithRules = async () => {
  // Load rules
  const rules = await db
    .select()
    .from(caseLawPolarityRules)
    .where(sql`${caseLawPolarityRules.source} IN ('manual', 'llm-promoted')`);

  if (rules.length === 0) {
    console.log("\nNo rules loaded, skipping polarity classification");
    return;
  }

  const compiled = rules.map((r) => ({
    id: r.id,
    pattern: new RegExp(r.pattern, "i"),
    polarity: r.polarity,
  }));

  console.log(`\nClassifying polarity with ${compiled.length} rules...`);

  // Count unclassified resolved citations
  const [polRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(caseLawCitations)
    .where(
      sql`${caseLawCitations.citedDecisionId} IS NOT NULL
          AND ${caseLawCitations.polarity} IS NULL`,
    );
  const count = polRow?.count ?? 0;

  console.log(`  ${count} resolved citations need classification`);

  let processed = 0;
  let classified = 0;
  let noMatch = 0;

  while (true) {
    const batch = await db
      .select({
        id: caseLawCitations.id,
        citingDecisionId: caseLawCitations.citingDecisionId,
        citationText: caseLawCitations.citationText,
        sectionIndex: caseLawCitations.sectionIndex,
      })
      .from(caseLawCitations)
      .where(
        sql`${caseLawCitations.citedDecisionId} IS NOT NULL
            AND ${caseLawCitations.polarity} IS NULL`,
      )
      .limit(BATCH_SIZE);

    if (batch.length === 0) {
      break;
    }

    for (const row of batch) {
      // Get the citing decision's sections for context
      const [decision] = await db
        .select({ sections: caseLawDecisions.sections })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, row.citingDecisionId))
        .limit(1);

      // SAFETY: sections column stores segmented decision text
      // with { index, text } shape, or null.
      const rawSections = decision?.sections;
      const sections = Array.isArray(rawSections) ? rawSections : [];
      const context = extractContext(
        sections,
        row.citationText,
        row.sectionIndex,
      );

      // Match against rules
      let matched = false;
      for (const rule of compiled) {
        if (context && rule.pattern.test(context)) {
          if (!DRY_RUN && !REPORT_ONLY) {
            await db
              .update(caseLawCitations)
              .set({
                polarity: rule.polarity,
                polarityRuleId: rule.id,
              })
              .where(eq(caseLawCitations.id, row.id));
          }
          classified++;
          matched = true;
          break;
        }
      }

      if (!matched) {
        // Set as "unknown" so we don't re-process
        if (!DRY_RUN && !REPORT_ONLY) {
          await db
            .update(caseLawCitations)
            .set({ polarity: "unknown" })
            .where(eq(caseLawCitations.id, row.id));
        }
        noMatch++;
      }

      processed++;
      if (processed % 5000 === 0) {
        console.log(
          `  ${processed}/${count} (${classified} classified, ${noMatch} unknown)`,
        );
      }
    }

    if (REPORT_ONLY || DRY_RUN) {
      break;
    }
  }

  console.log(
    `  Done: ${classified} classified, ${noMatch} unknown ` +
      `out of ${processed}`,
  );
};

// ── Step 4: Report ──────────────────────────────────────

const printReport = async () => {
  console.log("\n=== CITATION REPORT ===\n");

  // Overall stats
  const [overall] = await db.execute(sql`
    SELECT
      COUNT(*) as total,
      COUNT(cited_decision_id) as resolved,
      COUNT(polarity) as classified,
      COUNT(CASE WHEN polarity = 'positive' THEN 1 END) as positive,
      COUNT(CASE WHEN polarity = 'supportive' THEN 1 END) as supportive,
      COUNT(CASE WHEN polarity = 'neutral' THEN 1 END) as neutral,
      COUNT(CASE WHEN polarity = 'negative' THEN 1 END) as negative,
      COUNT(CASE WHEN polarity = 'unknown' THEN 1 END) as unknown
    FROM case_law_citations
  `);
  console.log("Overall:", JSON.stringify(overall));

  // Top resolved citations (most cited decisions)
  const topCited = await db.execute(sql`
    SELECT
      d.case_number,
      d.court,
      COUNT(*) as citation_count,
      COUNT(CASE WHEN c.polarity = 'positive' THEN 1 END) as positive,
      COUNT(CASE WHEN c.polarity = 'supportive' THEN 1 END) as supportive,
      COUNT(CASE WHEN c.polarity = 'negative' THEN 1 END) as negative,
      COUNT(CASE WHEN c.polarity = 'neutral' THEN 1 END) as neutral
    FROM case_law_citations c
    JOIN case_law_decisions d ON d.id = c.cited_decision_id
    GROUP BY d.case_number, d.court
    ORDER BY citation_count DESC
    LIMIT 15
  `);
  console.log("\nTop 15 most cited decisions:");
  for (const row of topCited) {
    const caseNumber = formatSqlValue(row["case_number"]);
    const court = formatSqlValue(row["court"]);
    const citationCount = formatSqlValue(row["citation_count"]);
    const positive = formatSqlValue(row["positive"]);
    const supportive = formatSqlValue(row["supportive"]);
    const neutral = formatSqlValue(row["neutral"]);
    const negative = formatSqlValue(row["negative"]);

    console.log(
      `  ${caseNumber} (${court}) — ` +
        `${citationCount} citations ` +
        `(+${positive} / ^${supportive} / ~${neutral} / -${negative})`,
    );
  }

  // Sample unresolved citations
  const unresolved = await db.execute(sql`
    SELECT citation_text, COUNT(*) as cnt
    FROM case_law_citations
    WHERE cited_decision_id IS NULL
    GROUP BY citation_text
    ORDER BY cnt DESC
    LIMIT 20
  `);
  console.log("\nTop 20 unresolved citations (not in our DB):");
  for (const row of unresolved) {
    const citationText = formatSqlValue(row["citation_text"]);
    const count = formatSqlValue(row["cnt"]);
    const norm = normalizeCitation(citationText);
    const suffix = (() => {
      if (norm.caseNumber) {
        return ` → "${norm.caseNumber}"`;
      }
      if (norm.ecli) {
        return ` → ECLI`;
      }
      return " → ???";
    })();
    console.log(`  [${count}x] ${citationText}${suffix}`);
  }

  // Sample ambiguous citations (same case number, multiple decisions)
  const ambiguous = await db.execute(sql`
    SELECT case_number, COUNT(*) as decision_count
    FROM case_law_decisions
    GROUP BY case_number
    HAVING COUNT(*) > 1
    ORDER BY COUNT(*) DESC
    LIMIT 15
  `);
  console.log("\nTop 15 ambiguous case numbers (multiple decisions):");
  for (const row of ambiguous) {
    const caseNumber = formatSqlValue(row["case_number"]);
    const decisionCount = formatSqlValue(row["decision_count"]);

    console.log(`  "${caseNumber}" → ${decisionCount} decisions`);
  }

  // Sample POSITIVE polarity with context (how the rule matched)
  for (const pol of [
    "positive",
    "supportive",
    "negative",
    "neutral",
  ] as const) {
    const examples = await db.execute(sql`
      SELECT
        c.citation_text,
        d_citing.case_number as citing_case,
        d_cited.case_number as cited_case,
        c.polarity,
        r.pattern as rule_pattern,
        d_citing.fulltext
      FROM case_law_citations c
      JOIN case_law_decisions d_citing
        ON d_citing.id = c.citing_decision_id
      JOIN case_law_decisions d_cited
        ON d_cited.id = c.cited_decision_id
      LEFT JOIN case_law_polarity_rules r
        ON r.id = c.polarity_rule_id
      WHERE c.polarity = ${pol}
        AND d_citing.fulltext IS NOT NULL
      ORDER BY random()
      LIMIT 5
    `);

    if (examples.length > 0) {
      console.log(
        `\n=== ${pol.toUpperCase()} examples (${examples.length}) ===`,
      );
      for (const row of examples) {
        const citationText = formatSqlValue(row["citation_text"]);
        const citingCase = formatSqlValue(row["citing_case"]);
        const citedCase = formatSqlValue(row["cited_case"]);
        const rulePattern = formatSqlValue(row["rule_pattern"]) || "none";

        // Extract ~100 chars around the citation in fulltext
        const ft = formatSqlValue(row["fulltext"]);
        const citPos = ft.indexOf(citationText);
        const start = Math.max(0, citPos - 80);
        const end = Math.min(ft.length, citPos + citationText.length + 80);
        const context =
          citPos !== -1
            ? `...${ft.slice(start, end).replace(/\n/g, " ")}...`
            : "(context not found in fulltext)";

        console.log(`  ${citingCase} → ${citedCase}`);
        console.log(`    rule: /${rulePattern}/`);
        console.log(`    context: ${context}`);
        console.log();
      }
    }
  }

  // Sample UNKNOWN polarity (need LLM or manual review)
  const unknownPol = await db.execute(sql`
    SELECT
      c.citation_text,
      d_citing.case_number as citing_case,
      d_cited.case_number as cited_case,
      d_citing.fulltext
    FROM case_law_citations c
    JOIN case_law_decisions d_citing
      ON d_citing.id = c.citing_decision_id
    JOIN case_law_decisions d_cited
      ON d_cited.id = c.cited_decision_id
    WHERE c.polarity = 'unknown'
      AND d_citing.fulltext IS NOT NULL
    ORDER BY random()
    LIMIT 10
  `);
  if (unknownPol.length > 0) {
    console.log("\n=== UNKNOWN polarity (10 samples for manual review) ===");
    for (const row of unknownPol) {
      const citationText = formatSqlValue(row["citation_text"]);
      const citingCase = formatSqlValue(row["citing_case"]);
      const citedCase = formatSqlValue(row["cited_case"]);
      const ft = formatSqlValue(row["fulltext"]);
      const citPos = ft.indexOf(citationText);
      const start = Math.max(0, citPos - 100);
      const end = Math.min(ft.length, citPos + citationText.length + 100);
      const context =
        citPos !== -1
          ? `...${ft.slice(start, end).replace(/\n/g, " ")}...`
          : "(context not found)";

      console.log(`  ${citingCase} → ${citedCase}`);
      console.log(`    context: ${context}`);
      console.log();
    }
  }
};

// ── Main ────────────────────────────────────────────────

console.log(
  (() => {
    if (DRY_RUN) {
      return "=== DRY RUN (no DB writes) ===";
    }
    if (REPORT_ONLY) {
      return "=== REPORT ONLY ===";
    }
    return "=== RESOLVING CITATIONS ===";
  })(),
);

if (!REPORT_ONLY) {
  if (!DRY_RUN) {
    await seedRules();
  }
  const stats = await resolveCitations();
  console.log("\nResolution stats:", JSON.stringify(stats, null, 2));

  if (stats.resolved > 0) {
    await classifyWithRules();
  }
}

await printReport();

process.exit(0);
