/**
 * Give stored Czech and Slovak decisions the court identity ingestion now
 * assigns: the court directory's id, and the court's official name.
 *
 * **What the repair reads.** Each row's stored court name, read onto the
 * court directory through `readPrintedCourt`, the same reading the write
 * boundary applies to a new decision. Nothing is fetched from a publisher.
 *
 * **What it writes.** A row stored under the official name gets the court id
 * alone. A row stored under another spelling of a directory court gets the
 * id and the official name, and the printed spelling is kept in the row's
 * metadata where the metadata does not already state the court. A row
 * without a publisher document id is found by a later observation through
 * its stored court name; the rename moves that name to the one the write
 * path now stores, so the same decision is found rather than written again.
 *
 * **What it does not reach.** A name no directory court answers to, or one
 * several answer to, is reported by spelling and left alone: no id is
 * inferred from the row's ECLI or anything else. Such rows keep a null court
 * id until the directory learns the spelling or the decision is re-ingested.
 * A row that already carries a different court id is reported, never changed.
 *
 * **Re-projection.** The court name is projected text, so a renamed row is
 * written in its own transaction under the corpus projection source lock and
 * its desired projection state is reconciled in the same transaction, as the
 * ingestion pipeline does. An id-only write changes no projected text and is
 * applied set-based, a page at a time.
 *
 * **Idempotence.** Every write is guarded on the court name the walk read and
 * on the row still lacking an id, so a repaired row is held on the next run
 * and a row the crawl re-ingested under the run is left as the crawl wrote it.
 *
 * **Rollback.** `--log <file>` (or `--log -`, for the task's own log stream)
 * records one JSON line per written row; `--rollback <file>` replays such a
 * log backwards, guarded on the values the run wrote.
 *
 *   # what the repair would change, writing nothing
 *   bun run src/scripts/repair-court-identity.ts [--source sk-courts]
 *
 *   # write, bounded and resumable by re-running
 *   bun run src/scripts/repair-court-identity.ts --apply --log - \
 *     [--source cz-regional] [--kind rename|assign-id] [--limit 50000] [--page 2000]
 *
 *   # put a logged run back
 *   bun run src/scripts/repair-court-identity.ts --apply --rollback writes.jsonl
 */

import { panic } from "better-result";
import { appendFileSync, readFileSync } from "node:fs";

import { runScriptWithErrorOutput } from "@stll/errors/script-error";

import type { SafeId } from "@/api/lib/branded-types";
import {
  enterCaseLawMaintenanceLane,
  openCaseLawReadOnlySession,
} from "@/api/lib/case-law/maintenance-lane";
import { executedRows } from "@/api/lib/db/executed-rows";
import {
  lockActiveCorpusProjectionSourceTx,
  synchronizeLockedCorpusProjectionDesiredStateTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";
import {
  assignCourtIdsStatement,
  COURT_IDENTITY_REPAIR_ADAPTERS,
  COURT_IDENTITY_REPAIR_OUTCOMES,
  courtIdentitySourcesStatement,
  decideCourtIdentityRepair,
  isCourtIdentityRepairAdapter,
  parseCourtIdentityPage,
  parseCourtIdentitySources,
  parseCourtIdentityWrite,
  renameCourtStatement,
  revertCourtIdentityStatement,
  selectCourtIdentityPageStatement,
} from "@/api/scripts/repair-court-identity-plan";
import type {
  CourtIdentityAssignment,
  CourtIdentityCursor,
  CourtIdentitySource,
  CourtIdentityWrite,
} from "@/api/scripts/repair-court-identity-plan";
import {
  flagInteger,
  hasFlag,
  readApplyFlag,
  rejectUnknownFlags,
  requiredFlagValue,
} from "@/api/scripts/repair-flags";

/** Rows one page of the walk examines, matching or not. */
const DEFAULT_PAGE_SIZE = 2000;

/** Rows this run may write; an operator raises it per stage. */
const DEFAULT_LIMIT = 50_000;

const KINDS = ["rename", "assign-id"] as const;

const USAGE = `Usage: bun run src/scripts/repair-court-identity.ts [options]

  --apply             Write. Omitted, the run only reports.
  --dry-run           Report only, the default; contradicts --apply.
  --source <adapter>  Walk one source: ${COURT_IDENTITY_REPAIR_ADAPTERS.join(", ")}.
  --kind <kind>       Write only renames or only id assignments: ${KINDS.join(", ")}.
  --limit <n>         Rows this run may write (default ${String(DEFAULT_LIMIT)}).
  --page <n>          Rows one statement examines (default ${String(DEFAULT_PAGE_SIZE)}).
  --log <file|->      Append one JSON line per written row (- for stdout).
  --rollback <file>   Revert the rows a --log file records (needs --apply).`;

rejectUnknownFlags({
  known: ["source", "kind", "limit", "page", "log", "rollback"],
  usage: USAGE,
});
const apply = readApplyFlag(USAGE);
const limit = flagInteger({
  fallback: DEFAULT_LIMIT,
  name: "limit",
  usage: USAGE,
});
const pageSize = flagInteger({
  fallback: DEFAULT_PAGE_SIZE,
  name: "page",
  usage: USAGE,
});
const sourceFilter = hasFlag("source")
  ? requiredFlagValue({ name: "source", usage: USAGE })
  : undefined;
if (sourceFilter !== undefined && !isCourtIdentityRepairAdapter(sourceFilter)) {
  console.error(`--source ${sourceFilter} is not a source this repair walks.`);
  console.error(USAGE);
  process.exit(1);
}
const kindFlag = hasFlag("kind")
  ? requiredFlagValue({ name: "kind", usage: USAGE })
  : undefined;
const kind = KINDS.find((candidate) => candidate === kindFlag);
if (kindFlag !== undefined && kind === undefined) {
  console.error(`--kind ${kindFlag} is not one of ${KINDS.join(", ")}.`);
  console.error(USAGE);
  process.exit(1);
}
const logTarget = hasFlag("log")
  ? requiredFlagValue({ name: "log", usage: USAGE })
  : undefined;
const rollbackFile = hasFlag("rollback")
  ? requiredFlagValue({ name: "rollback", usage: USAGE })
  : undefined;
if (rollbackFile !== undefined && !apply) {
  console.error("--rollback writes; pass --apply with it.");
  process.exit(1);
}

const { ingestionDb, rootDb } = apply
  ? await enterCaseLawMaintenanceLane()
  : await openCaseLawReadOnlySession();

const logWrite = (write: CourtIdentityWrite): void => {
  if (logTarget === undefined) {
    return;
  }
  const line = JSON.stringify(write);
  if (logTarget === "-") {
    console.info(`court-identity-write ${line}`);
    return;
  }
  appendFileSync(logTarget, `${line}\n`);
};

/**
 * Write one row under its corpus projection source lock, reconciling its projection in the
 * same transaction when the change is projected text.
 */
const writeWithProjection = async (
  decisionId: SafeId<"caseLawDecision">,
  write: (
    tx: Parameters<Parameters<typeof ingestionDb>[0]>[0],
  ) => Promise<boolean>,
): Promise<boolean> =>
  await ingestionDb(async (tx) => {
    const subject = { family: "case_law", entityId: decisionId } as const;
    const lock = await lockActiveCorpusProjectionSourceTx(tx, subject);
    const written = await write(tx);
    if (written && lock !== null) {
      await synchronizeLockedCorpusProjectionDesiredStateTx(tx, {
        lock,
        subject,
      });
    }
    return written;
  });

const rollback = async (file: string): Promise<void> => {
  const lines = readFileSync(file, "utf-8")
    .split("\n")
    .map((line) => line.replace(/^court-identity-write /u, "").trim())
    .filter((line) => line.length > 0);
  let reverted = 0;
  let changedSince = 0;
  for (const line of lines.toReversed()) {
    const write = parseCourtIdentityWrite(line);
    const id = brandPersistedCaseLawDecisionId(write.id);
    const revert = async (
      tx: Parameters<Parameters<typeof ingestionDb>[0]>[0],
    ): Promise<boolean> =>
      // audit: skip — operator revert of a derived court identity
      executedRows(await tx.execute(revertCourtIdentityStatement(write)))
        .length > 0;
    const revertRow =
      write.from === write.to
        ? async () => await ingestionDb(revert)
        : async () => await writeWithProjection(id, revert);
    // db-await-in-loop: one transaction per row, each with its projection lock
    const written = await revertRow();
    if (written) {
      reverted += 1;
    } else {
      changedSince += 1;
    }
  }
  console.info(
    `${reverted.toLocaleString()} rows reverted, ${changedSince.toLocaleString()} changed since the run and left alone.`,
  );
};

type Tally = {
  examined: number;
  held: number;
  assignId: number;
  rename: number;
  assignIdWritten: number;
  renameWritten: number;
  superseded: number;
  outOfScope: number;
  conflictingIds: Map<string, number>;
  renames: Map<string, number>;
  unknown: Map<string, number>;
  ambiguous: Map<string, number>;
};

const newTally = (): Tally => ({
  examined: 0,
  held: 0,
  assignId: 0,
  rename: 0,
  assignIdWritten: 0,
  renameWritten: 0,
  superseded: 0,
  outOfScope: 0,
  conflictingIds: new Map(),
  renames: new Map(),
  unknown: new Map(),
  ambiguous: new Map(),
});

const count = (map: Map<string, number>, key: string): void => {
  map.set(key, (map.get(key) ?? 0) + 1);
};

let written = 0;
const remaining = (): number => limit - written;

const renameRow = async (
  source: CourtIdentitySource,
  assignment: CourtIdentityAssignment,
  tally: Tally,
): Promise<void> => {
  const done = await writeWithProjection(
    assignment.row.id,
    async (tx) =>
      // audit: skip — operator repair of a derived court identity
      executedRows(
        await tx.execute(
          renameCourtStatement({
            courtId: assignment.courtId,
            from: assignment.from,
            id: assignment.row.id,
            to: assignment.to,
          }),
        ),
      ).length > 0,
  );
  if (!done) {
    tally.superseded += 1;
    return;
  }
  written += 1;
  tally.renameWritten += 1;
  logWrite({
    id: assignment.row.id,
    adapter: source.adapterKey,
    from: assignment.from,
    to: assignment.to,
    courtId: assignment.courtId,
    previousCourtId: assignment.row.courtId,
    addedMetadataCourt: !assignment.row.metadataHasCourt,
  });
};

const assignIds = async (
  source: CourtIdentitySource,
  assignments: readonly CourtIdentityAssignment[],
  tally: Tally,
): Promise<void> => {
  if (assignments.length === 0) {
    return;
  }
  const ids = new Set(
    executedRows(
      await ingestionDb(
        async (tx) =>
          // audit: skip — operator repair of a derived court identity
          await tx.execute(assignCourtIdsStatement(assignments)),
      ),
    ).flatMap((row) =>
      typeof row === "object" &&
      row !== null &&
      "id" in row &&
      typeof row.id === "string"
        ? [row.id]
        : [],
    ),
  );
  for (const assignment of assignments) {
    if (!ids.has(assignment.row.id)) {
      tally.superseded += 1;
      continue;
    }
    written += 1;
    tally.assignIdWritten += 1;
    logWrite({
      id: assignment.row.id,
      adapter: source.adapterKey,
      from: assignment.from,
      to: assignment.to,
      courtId: assignment.courtId,
      previousCourtId: assignment.row.courtId,
      addedMetadataCourt: false,
    });
  }
};

const walkSource = async (source: CourtIdentitySource): Promise<Tally> => {
  const tally = newTally();
  let cursor: CourtIdentityCursor | null = null;
  while (remaining() > 0) {
    const pageStatement = selectCourtIdentityPageStatement({
      after: cursor,
      pageSize,
      sourceId: source.id,
    });
    // db-await-in-loop: keyset page per iteration; the page is the batch
    const pageRows = await rootDb.execute(pageStatement);
    const page = parseCourtIdentityPage(executedRows(pageRows));
    if (page.cursor === null) {
      break;
    }
    cursor = page.cursor;
    const idOnly: CourtIdentityAssignment[] = [];
    for (const row of page.rows) {
      tally.examined += 1;
      const repair = decideCourtIdentityRepair(row);
      switch (repair.outcome) {
        case COURT_IDENTITY_REPAIR_OUTCOMES.HELD:
          tally.held += 1;
          break;
        case COURT_IDENTITY_REPAIR_OUTCOMES.OUT_OF_SCOPE:
          tally.outOfScope += 1;
          break;
        case COURT_IDENTITY_REPAIR_OUTCOMES.UNKNOWN:
          count(tally.unknown, repair.spelling);
          break;
        case COURT_IDENTITY_REPAIR_OUTCOMES.AMBIGUOUS:
          count(tally.ambiguous, repair.spelling);
          break;
        case COURT_IDENTITY_REPAIR_OUTCOMES.CONFLICTING_ID:
          count(
            tally.conflictingIds,
            `${row.court} (stored ${row.courtId ?? "none"}, reads as ${repair.courtId})`,
          );
          break;
        case COURT_IDENTITY_REPAIR_OUTCOMES.ASSIGN_ID:
          tally.assignId += 1;
          if (apply && kind !== "rename" && idOnly.length < remaining()) {
            idOnly.push(repair);
          }
          break;
        case COURT_IDENTITY_REPAIR_OUTCOMES.RENAME:
          tally.rename += 1;
          count(
            tally.renames,
            `${repair.from} -> ${repair.to} [${repair.courtId}]`,
          );
          if (apply && kind !== "assign-id" && remaining() > 0) {
            // db-await-in-loop: one transaction per row: each takes its projection lock and syncs that row
            await renameRow(source, repair, tally);
          }
          break;
        default: {
          repair satisfies never;
          panic(`Unhandled court identity repair: ${JSON.stringify(repair)}`);
        }
      }
    }
    // db-await-in-loop: one set-based statement per page
    await assignIds(source, idOnly, tally);
  }
  return tally;
};

const printSorted = (title: string, map: Map<string, number>): void => {
  if (map.size === 0) {
    return;
  }
  console.info(`  ${title}:`);
  for (const [key, value] of [...map].toSorted((a, b) => b[1] - a[1])) {
    console.info(`    ${String(value).padStart(8)}  ${key}`);
  }
};

const report = (source: CourtIdentitySource, tally: Tally): void => {
  const writes = apply
    ? `; written: ${tally.assignIdWritten.toLocaleString()} ids, ${tally.renameWritten.toLocaleString()} renames, ${tally.superseded.toLocaleString()} changed under the run`
    : "";
  const otherCountry =
    tally.outOfScope > 0
      ? `; ${tally.outOfScope.toLocaleString()} rows of another country`
      : "";
  console.info(
    `${source.adapterKey}: ${tally.examined.toLocaleString()} examined, ${tally.held.toLocaleString()} held, ${tally.assignId.toLocaleString()} lack only the id, ${tally.rename.toLocaleString()} stored under another spelling${writes}${otherCountry}`,
  );
  printSorted("renames", tally.renames);
  printSorted(
    "names no directory court answers to (left alone)",
    tally.unknown,
  );
  printSorted(
    "names several directory courts answer to (left alone)",
    tally.ambiguous,
  );
  printSorted(
    "rows carrying another court id (left alone)",
    tally.conflictingIds,
  );
};

await runScriptWithErrorOutput(async () => {
  if (rollbackFile !== undefined) {
    await rollback(rollbackFile);
    process.exit(0);
  }
  const sources = parseCourtIdentitySources(
    executedRows(
      await rootDb.execute(
        courtIdentitySourcesStatement(
          sourceFilter === undefined
            ? COURT_IDENTITY_REPAIR_ADAPTERS
            : [sourceFilter],
        ),
      ),
    ),
  );
  if (sources.length === 0) {
    console.info("No source to walk is registered; nothing to do.");
    process.exit(0);
  }
  for (const source of sources) {
    if (remaining() <= 0) {
      console.info(
        `limit of ${String(limit)} writes reached; re-run to continue.`,
      );
      break;
    }
    // db-await-in-loop: one source walk at a time, bounded by the run's limit
    report(source, await walkSource(source));
  }
  if (!apply) {
    console.info("Report only. Re-run with --apply to write.");
  }
  process.exit(0);
});
