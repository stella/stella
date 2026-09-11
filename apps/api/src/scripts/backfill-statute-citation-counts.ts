/**
 * Seed exact statute and provision citation counts from the canonical
 * provision-citation table. Progress is durable in the count-state row;
 * membership triggers keep completed and in-flight ranges current while the
 * source writer continues to run.
 */
import { panic } from "better-result";
import { asc, eq, gt, sql } from "drizzle-orm";

import {
  caseLawProvisionCitations,
  caseLawStatuteCitationCountState,
  STATUTE_CITATION_COUNT_STATE_KEY,
  STATUTE_CITATION_COUNT_STATUS,
} from "@/api/db/schema";
import { enterCaseLawMaintenanceLane } from "@/api/lib/case-law/maintenance-lane";

const BATCH_SIZE = 500;
const { rootDb } = await enterCaseLawMaintenanceLane();

const seedCitationCountBatch = async () =>
  await rootDb.transaction(async (tx) => {
    const [state] = await tx
      .select({
        cursorDecisionId: caseLawStatuteCitationCountState.cursorDecisionId,
        status: caseLawStatuteCitationCountState.status,
      })
      .from(caseLawStatuteCitationCountState)
      .where(
        eq(
          caseLawStatuteCitationCountState.key,
          STATUTE_CITATION_COUNT_STATE_KEY,
        ),
      )
      .for("update")
      .limit(1);

    if (state === undefined) {
      return panic("Statute citation count state is missing");
    }

    if (state.status === STATUTE_CITATION_COUNT_STATUS.READY) {
      return { status: "ready" as const, decisions: 0 };
    }

    const decisionRows = await tx
      .selectDistinct({ decisionId: caseLawProvisionCitations.decisionId })
      .from(caseLawProvisionCitations)
      .where(
        state.cursorDecisionId === null
          ? undefined
          : gt(caseLawProvisionCitations.decisionId, state.cursorDecisionId),
      )
      .orderBy(asc(caseLawProvisionCitations.decisionId))
      .limit(BATCH_SIZE);

    const lastDecisionId = decisionRows.at(-1)?.decisionId;
    if (lastDecisionId === undefined) {
      await tx
        .update(caseLawStatuteCitationCountState)
        .set({
          cursorDecisionId: null,
          status: STATUTE_CITATION_COUNT_STATUS.READY,
          updatedAt: new Date(),
        })
        .where(
          eq(
            caseLawStatuteCitationCountState.key,
            STATUTE_CITATION_COUNT_STATE_KEY,
          ),
        );
      return { status: "ready" as const, decisions: 0 };
    }

    const ids = sql.join(
      decisionRows.map(({ decisionId }) => sql`${decisionId}::uuid`),
      sql`, `,
    );
    await tx.execute(sql`
      INSERT INTO case_law_statute_citation_memberships (
        decision_id, source_id, jurisdiction, work_eli, target_type, anchor
      )
      SELECT citation.decision_id, decision.source_id,
        citation.jurisdiction, citation.work_eli, 'work', ''
      FROM case_law_provision_citations citation
      INNER JOIN case_law_decisions decision ON decision.id = citation.decision_id
      WHERE citation.decision_id IN (${ids}) AND citation.work_eli IS NOT NULL
      UNION
      SELECT citation.decision_id, decision.source_id,
        citation.jurisdiction, citation.work_eli, 'provision', citation.anchor
      FROM case_law_provision_citations citation
      INNER JOIN case_law_decisions decision ON decision.id = citation.decision_id
      WHERE citation.decision_id IN (${ids})
        AND citation.work_eli IS NOT NULL
        AND citation.anchor <> ''
      ON CONFLICT DO NOTHING
    `);

    await tx
      .update(caseLawStatuteCitationCountState)
      .set({ cursorDecisionId: lastDecisionId, updatedAt: new Date() })
      .where(
        eq(
          caseLawStatuteCitationCountState.key,
          STATUTE_CITATION_COUNT_STATE_KEY,
        ),
      );

    return { status: "advanced" as const, decisions: decisionRows.length };
  });

let seededDecisions = 0;

while (true) {
  const batch = await seedCitationCountBatch();
  seededDecisions += batch.decisions;
  if (batch.status === "ready") {
    break;
  }
}

console.info(`Seeded citation counts from ${seededDecisions} decisions.`);
process.exit(0);
