import { panic } from "better-result";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";

import type { DecisionJudgeRole } from "@stll/api-contract/case-law-judges";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisionJudges,
  caseLawDecisions,
  caseLawJudges,
} from "@/api/db/schema";
import { judgeNameKey } from "@/api/handlers/case-law/judges/judge-name";
import type { SafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import type { DecisionJudgeInput } from "@/api/lib/legal-search/ingestion-types";
import { logger } from "@/api/lib/observability/logger";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";
import { isRecord } from "@/api/lib/type-guards";

/**
 * The query surface each write needs, structurally: the ingestion pipeline
 * passes its transaction and the roster import its own handle, and neither
 * has to be the other.
 */
type DecisionJudgeWriter = Pick<Transaction, "delete" | "insert" | "select">;

type StatementRunner = {
  execute: (query: SQLWrapper) => PromiseLike<unknown>;
};

type ReplaceDecisionJudgesOptions = {
  decisionId: SafeId<"caseLawDecision">;
  judges: readonly DecisionJudgeInput[];
};

type DecisionCourt = {
  country: string;
  court: string;
};

type DecisionJudgeRow = typeof caseLawDecisionJudges.$inferInsert;

/**
 * The decision's rows, keyed and positioned.
 *
 * `(decision_id, role, name_key)` is the primary key, so one name printed
 * twice in a role is one row: the second mention says nothing the first did
 * not. Position is the order within the role, as printed.
 */
const decisionJudgeRows = (
  decisionId: SafeId<"caseLawDecision">,
  judges: readonly DecisionJudgeInput[],
): DecisionJudgeRow[] => {
  const rows = new Map<string, DecisionJudgeRow>();
  const nextPosition = new Map<DecisionJudgeRole, number>();

  for (const { role, nameAsPrinted } of judges) {
    const nameKey = judgeNameKey(nameAsPrinted);
    if (nameKey === "") {
      continue;
    }
    const identity = `${role}:${nameKey}`;
    if (rows.has(identity)) {
      continue;
    }
    const position = nextPosition.get(role) ?? 0;
    nextPosition.set(role, position + 1);
    rows.set(identity, {
      decisionId,
      judgeId: null,
      nameAsPrinted,
      nameKey,
      role,
      position,
    });
  }

  return [...rows.values()];
};

const readDecisionCourt = async (
  tx: DecisionJudgeWriter,
  decisionId: SafeId<"caseLawDecision">,
): Promise<DecisionCourt> => {
  const [decision] = await tx
    .select({
      country: caseLawDecisions.country,
      court: caseLawDecisions.court,
    })
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.id, decisionId))
    .limit(1);

  return (
    decision ??
    panic(`Decision ${decisionId} has no row to take its judges' court from`)
  );
};

const rosterIdsByNameKey = async (
  tx: DecisionJudgeWriter,
  { country, court }: DecisionCourt,
  nameKeys: readonly string[],
): Promise<Map<string, SafeId<"caseLawJudge">>> => {
  const roster = await tx
    .select({ id: caseLawJudges.id, nameKey: caseLawJudges.nameKey })
    .from(caseLawJudges)
    .where(
      and(
        eq(caseLawJudges.country, country),
        eq(caseLawJudges.court, court),
        inArray(caseLawJudges.nameKey, [...nameKeys]),
      ),
    );

  return new Map(roster.map(({ id, nameKey }) => [nameKey, id]));
};

/**
 * Replace the judges a decision names, inside the caller's transaction.
 *
 * The decision states these names, so they are stored whether or not the
 * court's roster has been imported: an unmatched name keeps `judge_id` null
 * and is linked by {@link relinkUnmatchedDecisionJudgesPage} once the roster
 * arrives. The miss is reported, never swallowed: a court whose names never
 * match is a parser or roster defect, and silence is what would hide it.
 */
export const replaceDecisionJudges = async (
  tx: DecisionJudgeWriter,
  { decisionId, judges }: ReplaceDecisionJudgesOptions,
): Promise<void> => {
  // audit: skip — public case-law data written by ingestion, not a user action
  await tx
    .delete(caseLawDecisionJudges)
    .where(eq(caseLawDecisionJudges.decisionId, decisionId));

  const rows = decisionJudgeRows(decisionId, judges);
  if (rows.length === 0) {
    return;
  }

  const decisionCourt = await readDecisionCourt(tx, decisionId);
  const rosterIds = await rosterIdsByNameKey(
    tx,
    decisionCourt,
    rows.map(({ nameKey }) => nameKey),
  );

  for (const row of rows) {
    const judgeId = rosterIds.get(row.nameKey);
    if (judgeId === undefined) {
      // `judgeKey`, not `nameKey`: the logger drops attribute keys that read
      // as free text (`name` among them) before they are shipped.
      logger.warn("case_law.judge_unmatched", {
        country: decisionCourt.country,
        court: decisionCourt.court,
        judgeKey: row.nameKey,
      });
      continue;
    }
    row.judgeId = judgeId;
  }

  await tx.insert(caseLawDecisionJudges).values(rows);
};

type RelinkUnmatchedDecisionJudgesPageOptions = DecisionCourt & {
  /** The last decision a previous page covered; `null` starts the walk. */
  after: SafeId<"caseLawDecision"> | null;
  /** How many decisions this page covers. */
  size: number;
};

export type RelinkUnmatchedDecisionJudgesPage = {
  linked: number;
  /** The last decision this page covered, the next page's `after`. */
  cursor: SafeId<"caseLawDecision"> | null;
  done: boolean;
};

/**
 * Link the names a roster import has just made matchable, one page of
 * decisions at a time.
 *
 * Runs after a roster import; the court is the one that was imported, and a
 * decision's court is the decision's own, so a name shared with another
 * court's judge stays unmatched. Only names the roster holds are candidates,
 * which the unmatched-name index answers directly.
 *
 * A page is bounded by decisions, not rows, so every row of a decision is
 * settled in the page that names it and the keyset cursor never splits one.
 * The cursor, not the shrinking candidate set, ends the walk: a name another
 * court's decision shares with this roster stays unmatched and would
 * otherwise be read again by every page.
 */
export const relinkUnmatchedDecisionJudgesPage = async (
  db: StatementRunner,
  { country, court, after, size }: RelinkUnmatchedDecisionJudgesPageOptions,
): Promise<RelinkUnmatchedDecisionJudgesPage> => {
  // audit: skip — relinks derived public case-law judge attributions
  const result = await db.execute(sql`
    WITH page AS (
      SELECT DISTINCT dj.decision_id
        FROM ${caseLawDecisionJudges} AS dj
        JOIN ${caseLawDecisions} AS d ON d.id = dj.decision_id
       WHERE dj.judge_id IS NULL
         AND dj.name_key IN (
           SELECT j.name_key
             FROM ${caseLawJudges} AS j
            WHERE j.country = ${country}
              AND j.court = ${court}
         )
         AND d.country = ${country}
         AND d.court = ${court}
         ${after === null ? sql`` : sql`AND dj.decision_id > ${after}`}
       ORDER BY dj.decision_id
       LIMIT ${size}
    ),
    linked AS (
      UPDATE ${caseLawDecisionJudges} AS dj
         SET judge_id = j.id
        FROM page, ${caseLawJudges} AS j
       WHERE dj.decision_id = page.decision_id
         AND dj.judge_id IS NULL
         AND dj.name_key = j.name_key
         AND j.country = ${country}
         AND j.court = ${court}
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM page)::int AS covered,
           (SELECT count(*) FROM linked)::int AS linked,
           (SELECT max(decision_id::text) FROM page) AS last
  `);

  const [row] = executedRows(result);
  if (
    !isRecord(row) ||
    typeof row["covered"] !== "number" ||
    typeof row["linked"] !== "number" ||
    !(row["last"] === null || typeof row["last"] === "string")
  ) {
    return panic("Decision judge relink page returned an invalid row");
  }

  return {
    linked: row["linked"],
    cursor:
      row["last"] === null
        ? after
        : brandPersistedCaseLawDecisionId(row["last"]),
    done: row["covered"] < size,
  };
};
