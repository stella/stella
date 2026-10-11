import { panic } from "better-result";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";
import * as v from "valibot";

import { sha256Hex } from "@stll/sha256/bun";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawCitations,
  caseLawDecisions,
  caseLawPolarityRules,
} from "@/api/db/schema";
import { runCitationGraphTransaction } from "@/api/handlers/case-law/citation-graph-transaction";
import { classifyCitedPart } from "@/api/handlers/case-law/polarity/cited-part";
import {
  POLARITIES,
  POLARITY,
  POLARITY_RULE_KIND,
  POLARITY_CLASSIFIER_VERSION,
} from "@/api/handlers/case-law/polarity/consts";
import { extractContexts } from "@/api/handlers/case-law/polarity/context";
import { unreviewedCitationSql } from "@/api/handlers/case-law/polarity/reviews";
import {
  ACTIVE_RULE_SOURCES,
  selectCitationPolarity,
} from "@/api/handlers/case-law/polarity/rule-engine";
import type { CompiledRule } from "@/api/handlers/case-law/polarity/rule-engine";
import { createSafeId } from "@/api/lib/branded-types";
import type { CaseLawRootHandle } from "@/api/lib/case-law/maintenance-lane";
import { citationTextRevisionFence } from "@/api/lib/case-law/text-revision";
import { numericColumnParam } from "@/api/lib/db/column-storage";
import { executedRows } from "@/api/lib/db/executed-rows";
import { readBounded } from "@/api/lib/db/read-bounded";
import { brandPersistedCaseLawCitationId } from "@/api/lib/safe-id-boundaries";
import { recordSystemAudit } from "@/api/lib/system-audit/record";

const REPAIR_LIMIT = 1000;
const formRepairRowSchema = v.object({
  id: v.pipe(v.string(), v.uuid()),
  jurisdiction: v.string(),
  oldPolarity: v.picklist(POLARITIES),
  oldRuleId: v.pipe(v.string(), v.uuid()),
  newPolarity: v.literal(POLARITY.NEUTRAL),
  newRuleId: v.pipe(v.string(), v.uuid()),
  fingerprint: v.string(),
  ruleFingerprint: v.string(),
});

export const formRepairPlanSchema = v.object({
  classifierVersion: v.literal(POLARITY_CLASSIFIER_VERSION),
  language: v.string(),
  after: v.nullable(v.pipe(v.string(), v.uuid())),
  rows: v.pipe(v.array(formRepairRowSchema), v.maxLength(REPAIR_LIMIT)),
  results: v.pipe(
    v.array(
      v.object({
        id: v.pipe(v.string(), v.uuid()),
        jurisdiction: v.string(),
        oldPolarity: v.nullable(v.picklist(POLARITIES)),
        newPolarity: v.nullable(v.picklist(POLARITIES)),
        status: v.picklist(["repair", "retained", "no-context"]),
      }),
    ),
    v.maxLength(REPAIR_LIMIT),
  ),
  counts: v.record(v.string(), v.number()),
  read: v.number(),
  noContext: v.number(),
});
export type FormRepairPlan = v.InferOutput<typeof formRepairPlanSchema>;

type RuleIdentityColumns = Record<
  "id" | "pattern" | "kind" | "polarity" | "confidence" | "source" | "language",
  SQLWrapper
>;

/** Preview and apply bind every stored field that identifies the selected rule. */
const ruleIdentityFingerprintSql = ({
  id,
  pattern,
  kind,
  polarity,
  confidence,
  source,
  language,
}: RuleIdentityColumns) =>
  sql<string>`jsonb_build_array(${id}, ${pattern}, ${kind}, ${polarity}, ${confidence}, ${source}, ${language})::text`;

type FormRepairCandidate = {
  id: string;
  citingDecisionId: string;
  jurisdiction: string;
  polarity: string | null;
  ruleId: string | null;
  citationText: string;
  sectionIndex: number | null;
  contentHash: string | null;
  sections: { text: string }[] | null;
};

const fingerprintOf = (candidate: FormRepairCandidate) =>
  sha256Hex(JSON.stringify(candidate));

/** Only a neutral rereading can repair a non-neutral form-derived label. */
export const planFormRepair = (
  candidate: FormRepairCandidate,
  rules: readonly CompiledRule[],
) => {
  const oldPolarity = v.parse(
    v.nullable(v.picklist(POLARITIES)),
    candidate.polarity,
  );
  if (
    oldPolarity === null ||
    oldPolarity === POLARITY.NEUTRAL ||
    candidate.ruleId === null
  ) {
    return { status: "retained" } as const;
  }
  const windows =
    candidate.sections === null
      ? null
      : extractContexts(
          candidate.sections,
          candidate.citationText,
          candidate.sectionIndex,
        );
  if (windows === null) {
    return { status: "no-context" } as const;
  }
  const verdict = selectCitationPolarity(rules, windows.mentions);
  if (verdict === null || verdict.polarity !== POLARITY.NEUTRAL) {
    return { status: "retained" } as const;
  }
  const rule = rules.find(({ id }) => id === verdict.ruleId);
  if (rule === undefined) {
    panic("A form repair verdict must identify a loaded rule");
  }
  return {
    status: "repair",
    rulePattern: rule.pattern,
    row: {
      id: candidate.id,
      jurisdiction: candidate.jurisdiction,
      oldPolarity,
      oldRuleId: candidate.ruleId,
      newPolarity: POLARITY.NEUTRAL,
      newRuleId: verdict.ruleId,
      fingerprint: fingerprintOf(candidate),
    },
    windows,
    confidence: verdict.confidence,
  } as const;
};

const candidateSelection = {
  id: caseLawCitations.id,
  citingDecisionId: caseLawCitations.citingDecisionId,
  jurisdiction: caseLawDecisions.country,
  polarity: caseLawCitations.polarity,
  ruleId: caseLawCitations.polarityRuleId,
  citationText: caseLawCitations.citationText,
  sectionIndex: caseLawCitations.sectionIndex,
  sections: caseLawDecisions.sections,
  contentHash: caseLawDecisions.contentHash,
};

const eligibleConditions = () => [
  eq(caseLawPolarityRules.kind, POLARITY_RULE_KIND.FORM),
  unreviewedCitationSql(caseLawCitations),
];

type PreviewFormRepairsArgs = {
  scopedDb: ScopedDb;
  language: string;
  rules: readonly CompiledRule[];
  after: string | null;
  limit: number;
};

/** A bounded, regex-only preview; no models or database mutations. */
export const previewFormRepairs = async ({
  scopedDb,
  language,
  rules,
  after,
  limit,
}: PreviewFormRepairsArgs): Promise<FormRepairPlan> => {
  const conditions = [
    ...eligibleConditions(),
    eq(caseLawDecisions.language, language),
  ];
  if (after !== null) {
    conditions.push(
      gt(caseLawCitations.id, brandPersistedCaseLawCitationId(after)),
    );
  }
  const pageSize = Math.max(1, Math.min(REPAIR_LIMIT, limit));
  const candidates = await scopedDb(
    async (tx) =>
      await tx
        .select(candidateSelection)
        .from(caseLawCitations)
        .innerJoin(
          caseLawDecisions,
          eq(caseLawDecisions.id, caseLawCitations.citingDecisionId),
        )
        .innerJoin(
          caseLawPolarityRules,
          eq(caseLawPolarityRules.id, caseLawCitations.polarityRuleId),
        )
        .where(and(...conditions))
        .orderBy(asc(caseLawCitations.id))
        .limit(pageSize),
  );
  const rows: Extract<
    ReturnType<typeof planFormRepair>,
    { status: "repair" }
  >["row"][] = [];
  const results: FormRepairPlan["results"] = [];
  let noContext = 0;
  for (const candidate of candidates) {
    const planned = planFormRepair(candidate, rules);
    results.push({
      id: candidate.id,
      jurisdiction: candidate.jurisdiction,
      oldPolarity: v.parse(
        v.nullable(v.picklist(POLARITIES)),
        candidate.polarity,
      ),
      newPolarity:
        planned.status === "repair"
          ? planned.row.newPolarity
          : v.parse(v.nullable(v.picklist(POLARITIES)), candidate.polarity),
      status: planned.status,
    });
    if (planned.status === "no-context") {
      noContext++;
    }
    if (planned.status !== "repair") {
      continue;
    }
    rows.push(planned.row);
  }
  const snapshots =
    rows.length === 0
      ? []
      : await scopedDb(
          async (tx) =>
            await tx
              .select({
                id: caseLawPolarityRules.id,
                pattern: caseLawPolarityRules.pattern,
                kind: caseLawPolarityRules.kind,
                polarity: caseLawPolarityRules.polarity,
                confidence: caseLawPolarityRules.confidence,
                ruleFingerprint:
                  ruleIdentityFingerprintSql(caseLawPolarityRules),
              })
              .from(caseLawPolarityRules)
              .where(
                and(
                  inArray(
                    caseLawPolarityRules.id,
                    rows.map(({ newRuleId }) => newRuleId),
                  ),
                  inArray(caseLawPolarityRules.source, ACTIVE_RULE_SOURCES),
                  eq(caseLawPolarityRules.language, language),
                ),
              ),
        );
  const snapshotById = new Map(
    snapshots.map((snapshot) => [snapshot.id, snapshot]),
  );
  const compiledById = new Map(rules.map((rule) => [rule.id, rule]));
  const readyRows = rows.flatMap((row) => {
    const snapshot = snapshotById.get(row.newRuleId);
    const compiled = compiledById.get(row.newRuleId);
    if (
      snapshot === undefined ||
      compiled === undefined ||
      snapshot.pattern !== compiled.pattern ||
      snapshot.kind !== compiled.kind ||
      snapshot.polarity !== compiled.polarity ||
      snapshot.confidence !== compiled.confidence
    ) {
      return [];
    }
    return [{ ...row, ruleFingerprint: snapshot.ruleFingerprint }];
  });
  const readyIds = new Set(readyRows.map(({ id }) => id));
  const counts = new Map<string, number>();
  for (const row of readyRows) {
    const key = `${row.jurisdiction}:${row.oldPolarity}->${row.newPolarity}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return {
    classifierVersion: POLARITY_CLASSIFIER_VERSION,
    language,
    after:
      candidates.length === pageSize ? (candidates.at(-1)?.id ?? null) : null,
    rows: readyRows,
    results: results.map((result) =>
      result.status === "repair" && !readyIds.has(result.id)
        ? {
            ...result,
            status: "retained" as const,
            newPolarity: result.oldPolarity,
          }
        : result,
    ),
    counts: Object.fromEntries(counts),
    read: candidates.length,
    noContext,
  };
};

type ApplyFormRepairsArgs = {
  transaction: CaseLawRootHandle["transaction"];
  plan: FormRepairPlan;
  rules: readonly CompiledRule[];
};

/** Re-read the preview set and compare-and-swap only unchanged, unreviewed rows. */
export const applyFormRepairs = async ({
  transaction,
  plan,
  rules,
}: ApplyFormRepairsArgs) => {
  if (plan.rows.length === 0) {
    return { applied: 0, skipped: 0 };
  }
  const expected = new Map(plan.rows.map((row) => [row.id, row]));
  return await runCitationGraphTransaction(transaction, async (tx) => {
    const read = await readBounded(
      tx
        .select(candidateSelection)
        .from(caseLawCitations)
        .innerJoin(
          caseLawDecisions,
          eq(caseLawDecisions.id, caseLawCitations.citingDecisionId),
        )
        .innerJoin(
          caseLawPolarityRules,
          eq(caseLawPolarityRules.id, caseLawCitations.polarityRuleId),
        )
        .where(
          and(
            ...eligibleConditions(),
            eq(caseLawDecisions.language, plan.language),
            inArray(
              caseLawCitations.id,
              plan.rows.map((row) => brandPersistedCaseLawCitationId(row.id)),
            ),
          ),
        ),
      expected.size,
    );
    if (read.type === "overflow") {
      panic("Repair reread exceeded its unique citation IDs", {
        cap: read.cap,
      });
    }
    const candidates = read.rows;
    const repairs: {
      candidate: (typeof candidates)[number];
      current: Extract<ReturnType<typeof planFormRepair>, { status: "repair" }>;
      ruleFingerprint: string;
    }[] = [];
    for (const candidate of candidates) {
      const previous = expected.get(candidate.id);
      const current = planFormRepair(candidate, rules);
      if (
        previous === undefined ||
        current.status !== "repair" ||
        previous.fingerprint !== current.row.fingerprint ||
        previous.newRuleId !== current.row.newRuleId ||
        previous.oldPolarity !== current.row.oldPolarity ||
        previous.oldRuleId !== current.row.oldRuleId
      ) {
        continue;
      }
      repairs.push({
        candidate,
        current,
        ruleFingerprint: previous.ruleFingerprint,
      });
    }
    const documents = new Map(
      repairs.map(({ candidate }) => [
        candidate.citingDecisionId,
        { sections: candidate.sections, contentHash: candidate.contentHash },
      ]),
    );
    const changed =
      repairs.length === 0
        ? []
        : await tx.execute(sql`
      WITH expected_documents(id, sections, content_hash) AS (VALUES ${sql.join(
        [...documents].map(
          ([id, revision]) =>
            sql`(${id}::uuid, ${revision.sections === null ? null : JSON.stringify(revision.sections)}::text::jsonb, ${revision.contentHash}::text)`,
        ),
        sql.raw(","),
      )}), repairs(id, citing_decision_id, citation_text, section_index, previous_polarity, previous_rule_id, rule_id, rule_pattern, rule_fingerprint, window_start, window_end, confidence, cited_part) AS (VALUES ${sql.join(
        repairs.map(
          ({ candidate, current, ruleFingerprint }) => sql`(
          ${candidate.id}::uuid, ${candidate.citingDecisionId}::uuid,
          ${candidate.citationText}::text, ${numericColumnParam(caseLawCitations.sectionIndex, candidate.sectionIndex)},
          ${current.row.oldPolarity}::text, ${current.row.oldRuleId}::uuid,
          ${current.row.newRuleId}::uuid, ${current.rulePattern}::text,
          ${ruleFingerprint}::text,
          ${numericColumnParam(caseLawCitations.polarityWindowStart, current.windows.evidenceSpan.start)}, ${numericColumnParam(caseLawCitations.polarityWindowEnd, current.windows.evidenceSpan.end)},
          ${numericColumnParam(caseLawCitations.polarityConfidence, current.confidence)}, ${classifyCitedPart({ contexts: current.windows.contexts, citationText: candidate.citationText, language: plan.language })}::text
        )`,
        ),
        sql.raw(","),
      )})
      UPDATE ${caseLawCitations} AS c
         SET polarity = ${POLARITY.NEUTRAL}, polarity_rule_id = v.rule_id,
             polarity_source = 'rule', polarity_classifier_version = ${POLARITY_CLASSIFIER_VERSION},
             polarity_window_start = v.window_start, polarity_window_end = v.window_end,
             polarity_confidence = v.confidence, cited_part = v.cited_part
        FROM repairs v
        JOIN expected_documents document ON document.id = v.citing_decision_id
        JOIN ${caseLawPolarityRules} old_rule ON old_rule.id = v.previous_rule_id AND old_rule.kind = ${POLARITY_RULE_KIND.FORM}
        JOIN ${caseLawPolarityRules} new_rule ON new_rule.id = v.rule_id
          AND new_rule.polarity = ${POLARITY.NEUTRAL} AND new_rule.pattern = v.rule_pattern
          AND new_rule.confidence = v.confidence
          AND ${ruleIdentityFingerprintSql({
            id: sql`new_rule.id`,
            pattern: sql`new_rule.pattern`,
            kind: sql`new_rule.kind`,
            polarity: sql`new_rule.polarity`,
            confidence: sql`new_rule.confidence`,
            source: sql`new_rule.source`,
            language: sql`new_rule.language`,
          })} = v.rule_fingerprint
          AND new_rule.source IN (${sql.join(
            ACTIVE_RULE_SOURCES.map((source) => sql`${source}`),
            sql.raw(","),
          )})
       WHERE c.id = v.id AND c.citing_decision_id = v.citing_decision_id
         AND ${citationTextRevisionFence({
           citingDecisionId: sql.raw("document.id"),
           expectedContentHash: sql.raw("document.content_hash"),
           expectedSections: sql.raw("document.sections"),
         })}
         AND c.citation_text = v.citation_text AND c.section_index IS NOT DISTINCT FROM v.section_index
         AND c.polarity = v.previous_polarity AND c.polarity_rule_id = v.previous_rule_id
         AND ${unreviewedCitationSql({ citingDecisionId: sql.raw("c.citing_decision_id"), citationKey: sql.raw("c.citation_key") })}
      RETURNING c.id
    `);
    const applied = executedRows(changed).length;
    const skipped = plan.rows.length - applied;
    await recordSystemAudit(tx, "system:case-law-citation-form-repair", {
      subject: createSafeId<"systemScriptRun">(),
      counts: { attempted: plan.rows.length, applied, skipped },
    });
    return { applied, skipped };
  });
};
