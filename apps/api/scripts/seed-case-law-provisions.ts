/**
 * Provision links for the synthetic Czech decisions of the seeded local
 * stack: the rows the provision extraction publishes for a decision, written
 * to the same tables, so the reader links the provisions a decision prints
 * and a provision's inspector lists the decisions citing it.
 *
 * A seeded stack runs no scheduler and no extraction worker, so this runs
 * what they would have. First the provision state backfill, which admits the
 * extraction scopes and owes state to every decision in them, as the
 * scheduler's task does. Then, in place of the worker's publish: one
 * registered extraction revision and, for every synthetic Czech decision, the
 * citation rows its text yields together with the published state that makes
 * them current. The generated decisions print no provision, so they publish
 * zero rows; the authored ones publish one row per printed citation, each
 * resolved through the Czech citation profile the extraction reads. The
 * statute citation counts are then rebuilt by the repair the backfill script
 * runs.
 *
 * Every row is derived from the fixture, and every id from a seed label, so a
 * re-seed writes nothing new.
 */

import { panic } from "better-result";
import { and, eq, isNull, sql } from "drizzle-orm";

import { isDocumentAst } from "@stll/legal-ast/document-ast";
import { section51StatuteAst } from "@stll/legal-ast/fixtures/cz-262-2006-section-51";
import {
  projectionDigest,
  projectionPieces,
  PROVISION_SPAN_PROJECTION_REVISION,
} from "@stll/legal-ast/projection-digest";
import { CZ_PROFILE } from "@stll/legal-atlas/cz-provision-citation-profile";
import { resolveProvisionCitation } from "@stll/legal-atlas/provision-citation-resolve";
import { sha256Hex } from "@stll/sha256/bun";

import type { Transaction } from "@/api/db/root";
import {
  caseLawProvisionCitations,
  caseLawProvisionExtractionRevisionsRegistry,
  caseLawProvisionExtractions,
} from "@/api/db/schema";
import { createStatuteCitationCountRepair } from "@/api/handlers/case-law/provisions/citation-count-repair";
import type { SafeId } from "@/api/lib/branded-types";
import { runProvisionStateBackfill } from "@/api/lib/case-law/provision-state-backfill/backfill";
import type { ProvisionBackfillSession } from "@/api/lib/case-law/provision-state-backfill/step";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";

import type { FixtureDecision } from "./seed-case-law";
import { AUTHORED_PROVISION_CITATIONS } from "./seed-case-law-synthetic";
import type { AuthoredProvisionCitation } from "./seed-case-law-synthetic";
import {
  SECTION_51_VERSION_DATE,
  seededStatuteEli,
  seededStatuteVersionId,
} from "./seed-legislation";
import { seedId } from "./seed-utils";

const JURISDICTION = "CZE";
/** The one extraction revision the seeded links are published under. */
const SEED_REVISION = 1;
/** The labour code: the seeded act whose consolidation holds cited wording. */
const LINKED_WORK = { number: 262, year: 2006, collection: "Sb." } as const;
/** Anchors the seeded § 51 consolidation holds, so a link to one is available. */
const LINKED_ANCHORS = new Set(
  section51StatuteAst.blocks.map(({ anchorId }) => anchorId),
);

/** A sentence ends at a stop followed by a capital: `odst. 1` does not. */
const SENTENCE_BOUNDARY = /(?<=[.!?])\s+(?=\p{Lu})/gu;

const sentenceAround = (text: string, start: number, end: number): string => {
  let from = 0;
  let to = text.length;
  for (const boundary of text.matchAll(SENTENCE_BOUNDARY)) {
    if (boundary.index < start) {
      from = boundary.index + boundary[0].length;
    } else if (boundary.index >= end) {
      to = boundary.index;
      break;
    }
  }
  return text.slice(from, to);
};

export type ProvisionCitationRow =
  typeof caseLawProvisionCitations.$inferInsert;

type ProvisionCitationRowsOptions = {
  decisionId: SafeId<"caseLawDecision">;
  decision: FixtureDecision;
  citations: readonly AuthoredProvisionCitation[];
};

/**
 * One row per printed occurrence of each citation, its span addressed in the
 * reader piece that prints it and in the decision's text.
 */
export const provisionCitationRows = ({
  decisionId,
  decision,
  citations,
}: ProvisionCitationRowsOptions): ProvisionCitationRow[] => {
  const ast = decision.document_ast;
  if (!isDocumentAst(ast)) {
    return panic(`${decision.case_number} has no document AST`);
  }
  const decisionDate =
    decision.decision_date ?? panic(`${decision.case_number} has no date`);
  const fulltext =
    decision.fulltext ?? panic(`${decision.case_number} has no text`);
  // The decision's text is its pieces joined by blank lines.
  let pieceStart = 0;
  const pieces = projectionPieces(ast).map((piece) => {
    const placed = { ...piece, start: pieceStart };
    pieceStart += piece.text.length + 2;
    return placed;
  });

  return citations.flatMap(({ provision, act }) => {
    const printed = `${provision} ${act}`;
    const resolution = resolveProvisionCitation({
      text: printed,
      profile: CZ_PROFILE,
      citedOn: decisionDate,
    });
    if (resolution.status !== "resolved") {
      return panic(`"${printed}" does not resolve: ${resolution.status}`);
    }
    const { work } = resolution;
    if (
      work.number !== LINKED_WORK.number ||
      work.year !== LINKED_WORK.year ||
      work.collection !== LINKED_WORK.collection ||
      decisionDate < SECTION_51_VERSION_DATE ||
      !LINKED_ANCHORS.has(resolution.anchor)
    ) {
      return panic(
        `"${printed}" in ${decision.case_number} is not wording the seeded labour code holds on ${decisionDate}`,
      );
    }

    const rows = pieces.flatMap((piece) => {
      const starts: number[] = [];
      for (
        let at = piece.text.indexOf(printed);
        at !== -1;
        at = piece.text.indexOf(printed, at + printed.length)
      ) {
        starts.push(at);
      }
      return starts.map((printStart): ProvisionCitationRow => {
        const printEnd = printStart + provision.length;
        const nameStart = printEnd + 1;
        const spanStart = piece.start + printStart;
        if (fulltext.slice(spanStart, spanStart + printed.length) !== printed) {
          return panic(`${decision.case_number} text and pieces disagree`);
        }
        return {
          id: seedId<"caseLawProvisionCitation">(
            `case-law-provision-citation-${decisionId}-${String(spanStart)}-${resolution.anchor}`,
          ),
          decisionId,
          jurisdiction: JURISDICTION,
          workIdentifier: resolution.workIdentifier,
          workNumber: work.number,
          workYear: work.year,
          workCollection: work.collection,
          workEli: seededStatuteEli(work),
          unit: resolution.unit,
          section: resolution.section,
          sectionSuffix: resolution.sectionSuffix,
          subsection: resolution.subsection,
          letter: resolution.letter,
          point: resolution.point,
          sentence: null,
          openEnded: false,
          anchor: resolution.anchor,
          // No version stated: the consolidation in force on the decision's
          // date, which is the seeded § 51 one.
          versionValidFrom: SECTION_51_VERSION_DATE,
          decisionDate,
          sentenceText: sentenceAround(
            piece.text,
            printStart,
            printStart + printed.length,
          ),
          spanStart,
          spanEnd: piece.start + printEnd,
          workSource: "title",
          confidence: 1,
          spanRole: "printed",
          printPieceId: piece.pieceId,
          printStart,
          printEnd,
          printText: provision,
          namePieceId: piece.pieceId,
          nameStart,
          nameEnd: nameStart + act.length,
          nameText: act,
          selection: "date-window",
          printedWorkIdentifier: null,
          targetDocumentId: seededStatuteVersionId({
            ...work,
            versionValidFrom: SECTION_51_VERSION_DATE,
          }),
          targetStatus: "available",
        };
      });
    });
    if (rows.length === 0) {
      return panic(`"${printed}" is not in ${decision.case_number}`);
    }
    return rows;
  });
};

export type SeededDecision = {
  id: SafeId<"caseLawDecision">;
  decision: FixtureDecision;
};

type SeedRootDb = {
  transaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>;
};

type ReservedConnection = {
  unsafe: (query: string, params: unknown[]) => PromiseLike<unknown>;
};

/** A reserved connection as the backfill's session, as the scheduler binds it. */
export const reservedBackfillSession = ({
  connection,
  setTransactionBudget,
}: {
  connection: ReservedConnection;
  setTransactionBudget: ProvisionBackfillSession["setTransactionBudget"];
}): ProvisionBackfillSession => ({
  setTransactionBudget,
  execute: async (query, params = []) => {
    await connection.unsafe(query, [...params]);
  },
  query: async (query, params = []) => {
    const rows = await connection.unsafe(query, [...params]);
    return Array.isArray(rows)
      ? rows
      : panic("The reserved connection returned a non-array result");
  },
});

/** Runs of the backfill a seeded corpus needs; more is a stuck step. */
const BACKFILL_RUN_LIMIT = 20;

/**
 * The scheduler's provision state backfill, run to completion: scope rows for
 * every decision key, the admitted scopes active, and state owed to every
 * decision in them.
 */
const completeProvisionStateBackfill = async (
  connection: ProvisionBackfillSession,
) => {
  for (let run = 0; run < BACKFILL_RUN_LIMIT; run += 1) {
    const outcome = (
      await runProvisionStateBackfill({
        connection,
        deadline: Number.POSITIVE_INFINITY,
        signal: new AbortController().signal,
      })
    ).unwrap("Provision state backfill failed");
    if (outcome.type === "complete") {
      return;
    }
    if (outcome.type !== "progress") {
      return panic(`Provision state backfill stopped: ${outcome.type}`);
    }
  }
  return panic("Provision state backfill did not complete");
};

type SeedProvisionLinksOptions = {
  rootDb: SeedRootDb;
  /** A dedicated session, as the scheduler gives the backfill. */
  backfill: ProvisionBackfillSession;
  decisions: readonly SeededDecision[];
};

/** Publish every synthetic Czech decision's provision links, then recount. */
export const seedSyntheticProvisionLinks = async ({
  rootDb,
  backfill,
  decisions,
}: SeedProvisionLinksOptions) => {
  const published = await Promise.all(
    decisions.map(async ({ id, decision }) => {
      const ast = decision.document_ast;
      if (!isDocumentAst(ast)) {
        return panic(`${decision.case_number} has no document AST`);
      }
      const rows = provisionCitationRows({
        decisionId: id,
        decision,
        citations: AUTHORED_PROVISION_CITATIONS.get(decision.case_number) ?? [],
      });
      return {
        id,
        rows,
        rowsDigest: sha256Hex(JSON.stringify(rows)),
        projectionDigest: await projectionDigest(ast),
      };
    }),
  );

  await completeProvisionStateBackfill(backfill);

  await withAggregateTransaction(rootDb, async (tx) => {
    await tx
      .insert(caseLawProvisionExtractionRevisionsRegistry)
      .values({
        revision: SEED_REVISION,
        jurisdiction: JURISDICTION,
        engineInputDigest: sha256Hex("stella-local-seed:provision-engine"),
        profileDigest: sha256Hex("stella-local-seed:provision-profile"),
        projectionRevision: PROVISION_SPAN_PROJECTION_REVISION,
      })
      .onConflictDoNothing();
    await tx.execute(
      sql`SELECT set_case_law_provision_extraction_revision(${JURISDICTION}, ${SEED_REVISION}, ${SEED_REVISION})`,
    );

    const rows = published.flatMap(({ rows: decisionRows }) => decisionRows);
    if (rows.length > 0) {
      await tx
        .insert(caseLawProvisionCitations)
        .values(rows)
        .onConflictDoNothing();
    }
    // The published side, written with the rows it describes. A decision
    // already published keeps its state.
    for (const decision of published) {
      await tx
        .update(caseLawProvisionExtractions)
        .set({
          generation: sql`${caseLawProvisionExtractions.generation} + 1`,
          outcome:
            decision.rows.length === 0
              ? "extracted_zero"
              : "extracted_with_rows",
          rowCount: decision.rows.length,
          rowsDigest: decision.rowsDigest,
          publishedProjectionDigest: sql`decode(${decision.projectionDigest}, 'hex')`,
          publishedRevision: SEED_REVISION,
          publishedJurisdiction: JURISDICTION,
          publishedInputDigest: sql`${caseLawProvisionExtractions.desiredInputDigest}`,
          publishedAt: sql`now()`,
          dueAt: null,
        })
        .where(
          and(
            eq(caseLawProvisionExtractions.decisionId, decision.id),
            isNull(caseLawProvisionExtractions.outcome),
          ),
        );
    }
  });

  const repairCounts = createStatuteCitationCountRepair(rootDb);
  while ((await repairCounts()).status !== "ready") {
    // Each call commits one bounded batch of decisions.
  }

  return {
    decisions: published.length,
    citations: published.reduce((total, { rows }) => total + rows.length, 0),
  };
};
