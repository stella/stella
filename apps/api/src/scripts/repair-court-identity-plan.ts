/**
 * The selection, the decision and the writes `repair-court-identity.ts` runs,
 * separated from the script that runs them, so a database test can execute
 * the statements and a unit test can exercise the decision.
 *
 * A Czech or Slovak decision stored before court identities were assigned at
 * ingestion carries the court name its publisher printed and no court id. The
 * repair reads that name onto the court directory exactly as ingestion now
 * does (`readPrintedCourt`), and gives the row the directory court's id and
 * official name. The printed name stays in the row's metadata.
 */

import { panic } from "better-result";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

import {
  isPrintedCourtJurisdiction,
  readPrintedCourt,
} from "@stll/api-contract/court-identity";

import type { SafeId } from "@/api/lib/branded-types";
import {
  pgTimestampCursorBoundary,
  pgTimestampCursorValue,
} from "@/api/lib/db-pagination";
import {
  brandPersistedCaseLawDecisionId,
  brandPersistedCaseLawSourceId,
} from "@/api/lib/safe-id-boundaries";
import { isRecord } from "@/api/lib/type-guards";

/**
 * The sources whose decisions are identified by a printed court name, by the
 * adapter that writes them. A source registered under another key is not
 * walked.
 */
export const COURT_IDENTITY_REPAIR_ADAPTERS = [
  "cz-regional",
  "cz-ns",
  "cz-ns-sbirka",
  "cz-isir",
  "cz-nss",
  "cz-us",
  "cz-uohs",
  "sk-courts",
  "sk-us",
] as const;

export type CourtIdentityRepairAdapter =
  (typeof COURT_IDENTITY_REPAIR_ADAPTERS)[number];

export const isCourtIdentityRepairAdapter = (
  value: string,
): value is CourtIdentityRepairAdapter =>
  COURT_IDENTITY_REPAIR_ADAPTERS.some((adapter) => adapter === value);

/** One stored decision, with what its court identity needs. */
export type CourtIdentityRow = {
  id: SafeId<"caseLawDecision">;
  country: string;
  court: string;
  courtId: string | null;
  /** Whether the row's metadata already states the court it was read with. */
  metadataHasCourt: boolean;
};

/** Where a walk of a source stands: the last row a page examined. */
export type CourtIdentityCursor = {
  /** The row's `created_at` as the database's own microsecond text. */
  createdAt: string;
  id: SafeId<"caseLawDecision">;
};

export type CourtIdentityPage = {
  /** Every row the page examined. */
  rows: CourtIdentityRow[];
  /** Where the next page starts, or null when the source is exhausted. */
  cursor: CourtIdentityCursor | null;
};

/** The sources the repair walks, looked up by the adapters that wrote them. */
export const courtIdentitySourcesStatement = (
  adapterKeys: readonly string[],
): SQL => sql`
  SELECT id, adapter_key
    FROM case_law_sources
   WHERE adapter_key IN (${sql.join(
     adapterKeys.map((key) => sql`${key}`),
     sql`, `,
   )})
   ORDER BY adapter_key, id
`;

export type CourtIdentitySource = {
  id: SafeId<"caseLawSource">;
  adapterKey: string;
};

export const parseCourtIdentitySources = (
  rows: readonly unknown[],
): CourtIdentitySource[] =>
  rows.map((row) => {
    if (
      !isRecord(row) ||
      typeof row["id"] !== "string" ||
      typeof row["adapter_key"] !== "string"
    ) {
      return panic(`Unreadable case-law source row: ${JSON.stringify(row)}`);
    }
    return {
      id: brandPersistedCaseLawSourceId(row["id"]),
      adapterKey: row["adapter_key"],
    };
  });

/**
 * One page of a walk of a source, every row of it. Bounded by rows examined,
 * in the order of the source's own cursor index (`source_id, created_at,
 * id`), as `selectCzNsCourtPageStatement` walks: the decision is made per row
 * in code, from the directory, so the statement cannot filter, and a page
 * that matches nothing still advances the cursor.
 */
export const selectCourtIdentityPageStatement = ({
  after,
  pageSize,
  sourceId,
}: {
  after: CourtIdentityCursor | null;
  pageSize: number;
  sourceId: SafeId<"caseLawSource">;
}): SQL => sql`
  SELECT d.id,
         ${pgTimestampCursorValue(sql`d.created_at`)} AS cursor_created_at,
         d.country,
         d.court,
         d.court_id,
         COALESCE(d.metadata ? 'court', false) AS metadata_has_court
    FROM case_law_decisions d
   WHERE d.source_id = ${sourceId}::uuid
     ${
       after === null
         ? sql``
         : sql`AND (d.created_at, d.id) > (${pgTimestampCursorBoundary({
             type: "pgTimestampCursor",
             value: after.createdAt,
             precision: "microseconds",
           })}, ${after.id}::uuid)`
     }
   ORDER BY d.created_at, d.id
   LIMIT ${pageSize}
`;

const requiredString = (value: unknown, column: string): string =>
  typeof value === "string"
    ? value
    : panic(`Court identity page column ${column} is not a string`);

const nullableString = (value: unknown, column: string): string | null =>
  value === null ? null : requiredString(value, column);

/** A page read back from a driver result that is untyped by construction. */
export const parseCourtIdentityPage = (
  rows: readonly unknown[],
): CourtIdentityPage => {
  const parsed = rows.map((row): CourtIdentityRow & { createdAt: string } => {
    if (!isRecord(row)) {
      return panic(`Unreadable court identity row: ${JSON.stringify(row)}`);
    }
    if (typeof row["metadata_has_court"] !== "boolean") {
      return panic("Court identity page column metadata_has_court");
    }
    return {
      id: brandPersistedCaseLawDecisionId(requiredString(row["id"], "id")),
      createdAt: requiredString(row["cursor_created_at"], "cursor_created_at"),
      country: requiredString(row["country"], "country"),
      court: requiredString(row["court"], "court"),
      courtId: nullableString(row["court_id"], "court_id"),
      metadataHasCourt: row["metadata_has_court"],
    };
  });
  const last = parsed.at(-1);
  return {
    rows: parsed.map(({ createdAt: _createdAt, ...row }) => row),
    cursor:
      last === undefined ? null : { createdAt: last.createdAt, id: last.id },
  };
};

export const COURT_IDENTITY_REPAIR_OUTCOMES = {
  /** The row already carries the directory court's id and official name. */
  HELD: "held",
  /** The row is stored under the official name and lacks only the id. */
  ASSIGN_ID: "assign-id",
  /** The row is stored under another spelling of a directory court. */
  RENAME: "rename",
  /** No directory court answers to the stored name. */
  UNKNOWN: "unknown",
  /** Several directory courts answer to the stored name. */
  AMBIGUOUS: "ambiguous",
  /** The row carries an id other than the one its name reads as. */
  CONFLICTING_ID: "conflicting-id",
  /** The row's country is not identified by a printed court name. */
  OUT_OF_SCOPE: "out-of-scope",
} as const;

export type CourtIdentityAssignment = {
  outcome:
    | typeof COURT_IDENTITY_REPAIR_OUTCOMES.ASSIGN_ID
    | typeof COURT_IDENTITY_REPAIR_OUTCOMES.RENAME;
  row: CourtIdentityRow;
  /** The court name the row holds now, which every write is guarded on. */
  from: string;
  /** The directory court's official name. */
  to: string;
  courtId: string;
};

export type CourtIdentityRepair =
  | CourtIdentityAssignment
  | {
      outcome:
        | typeof COURT_IDENTITY_REPAIR_OUTCOMES.HELD
        | typeof COURT_IDENTITY_REPAIR_OUTCOMES.OUT_OF_SCOPE;
      row: CourtIdentityRow;
    }
  | {
      outcome:
        | typeof COURT_IDENTITY_REPAIR_OUTCOMES.UNKNOWN
        | typeof COURT_IDENTITY_REPAIR_OUTCOMES.AMBIGUOUS;
      row: CourtIdentityRow;
      spelling: string;
    }
  | {
      outcome: typeof COURT_IDENTITY_REPAIR_OUTCOMES.CONFLICTING_ID;
      row: CourtIdentityRow;
      courtId: string;
    };

/**
 * What one stored row's court should be.
 *
 * A name the directory cannot place, or places on several courts, is
 * reported and left alone: no id is inferred from anything else the row
 * holds. A row that already carries an id is never given another one.
 */
export const decideCourtIdentityRepair = (
  row: CourtIdentityRow,
): CourtIdentityRepair => {
  if (!isPrintedCourtJurisdiction(row.country)) {
    return { outcome: COURT_IDENTITY_REPAIR_OUTCOMES.OUT_OF_SCOPE, row };
  }
  const reading = readPrintedCourt(row.country, row.court);
  switch (reading.type) {
    case "unknown":
      return {
        outcome: COURT_IDENTITY_REPAIR_OUTCOMES.UNKNOWN,
        row,
        spelling: row.court,
      };
    case "ambiguous":
      return {
        outcome: COURT_IDENTITY_REPAIR_OUTCOMES.AMBIGUOUS,
        row,
        spelling: row.court,
      };
    case "court": {
      const { id, name } = reading.court;
      if (row.courtId !== null && row.courtId !== id) {
        return {
          outcome: COURT_IDENTITY_REPAIR_OUTCOMES.CONFLICTING_ID,
          row,
          courtId: id,
        };
      }
      if (row.courtId === id && row.court === name) {
        return { outcome: COURT_IDENTITY_REPAIR_OUTCOMES.HELD, row };
      }
      return {
        outcome:
          row.court === name
            ? COURT_IDENTITY_REPAIR_OUTCOMES.ASSIGN_ID
            : COURT_IDENTITY_REPAIR_OUTCOMES.RENAME,
        row,
        from: row.court,
        to: name,
        courtId: id,
      };
    }
    default: {
      reading satisfies never;
      return panic(`Unhandled court reading: ${JSON.stringify(reading)}`);
    }
  }
};

/**
 * Give rows already stored under the official name their court id, in one
 * statement per page. Guarded on the name the walk read and on the row still
 * lacking an id, so a row the crawl re-ingested under the run is left as it
 * wrote it. Not a projection change: the id is not part of the projected
 * text, so nothing is re-enqueued.
 */
export const assignCourtIdsStatement = (
  assignments: readonly Pick<
    CourtIdentityAssignment,
    "row" | "to" | "courtId"
  >[],
): SQL => {
  if (assignments.length === 0) {
    return panic("assignCourtIdsStatement needs at least one row");
  }
  const values = sql.join(
    assignments.map(
      ({ row, to, courtId }) =>
        sql`(${row.id}::uuid, ${courtId}::text, ${to}::text)`,
    ),
    sql`, `,
  );
  return sql`
    UPDATE case_law_decisions AS d
       SET court_id = v.court_id
      FROM (VALUES ${values}) AS v(id, court_id, court)
     WHERE d.id = v.id
       AND d.court_id IS NULL
       AND d.court = v.court
    RETURNING d.id
  `;
};

/**
 * Store one row under its directory court: the id, the official name, and
 * the printed name in the metadata where the metadata does not state one
 * already (an adapter's own statement of the court is never overwritten).
 *
 * Guarded on the court the walk read and on the row lacking an id. `updated_at`
 * is set because the court is projected text and the PostgreSQL full-text
 * projection's staleness test reads it; the corpus index is reconciled by the
 * caller inside the same transaction.
 */
export const renameCourtStatement = ({
  courtId,
  from,
  id,
  to,
}: {
  courtId: string;
  from: string;
  id: SafeId<"caseLawDecision">;
  to: string;
}): SQL => sql`
  UPDATE case_law_decisions AS d
     SET court = ${to},
         court_id = ${courtId},
         metadata = CASE
           WHEN d.metadata ? 'court' THEN d.metadata
           ELSE jsonb_set(
             COALESCE(d.metadata, '{}'::jsonb), '{court}', to_jsonb(${from}::text)
           )
         END,
         updated_at = now()
   WHERE d.id = ${id}::uuid
     AND d.court = ${from}
     AND d.court_id IS NULL
  RETURNING d.id
`;

/**
 * One written row, as the run logs it: enough to put the row back
 * (`revertCourtIdentityStatement`).
 */
export type CourtIdentityWrite = {
  id: string;
  adapter: string;
  from: string;
  to: string;
  courtId: string;
  previousCourtId: string | null;
  /** Whether the run added the printed name to the row's metadata. */
  addedMetadataCourt: boolean;
};

export const parseCourtIdentityWrite = (line: string): CourtIdentityWrite => {
  const value: unknown = JSON.parse(line);
  if (
    !isRecord(value) ||
    typeof value["id"] !== "string" ||
    typeof value["adapter"] !== "string" ||
    typeof value["from"] !== "string" ||
    typeof value["to"] !== "string" ||
    typeof value["courtId"] !== "string" ||
    (value["previousCourtId"] !== null &&
      typeof value["previousCourtId"] !== "string") ||
    typeof value["addedMetadataCourt"] !== "boolean"
  ) {
    return panic(`Unreadable court identity log line: ${line.slice(0, 200)}`);
  }
  return {
    id: value["id"],
    adapter: value["adapter"],
    from: value["from"],
    to: value["to"],
    courtId: value["courtId"],
    previousCourtId: value["previousCourtId"],
    addedMetadataCourt: value["addedMetadataCourt"],
  };
};

/**
 * Put one logged row back as it was, guarded on what the run wrote: a row
 * changed since (re-ingested, or repaired again) is left alone. The metadata
 * court is removed only where the run added it and it still holds what the
 * run put there.
 */
export const revertCourtIdentityStatement = (
  write: CourtIdentityWrite,
): SQL => sql`
  UPDATE case_law_decisions AS d
     SET court = ${write.from},
         court_id = ${write.previousCourtId},
         metadata = CASE
           WHEN ${write.addedMetadataCourt}
            AND d.metadata ->> 'court' = ${write.from}
           THEN d.metadata - 'court'
           ELSE d.metadata
         END,
         updated_at = CASE
           WHEN ${write.from !== write.to} THEN now()
           ELSE d.updated_at
         END
   WHERE d.id = ${write.id}::uuid
     AND d.court = ${write.to}
     AND d.court_id = ${write.courtId}
  RETURNING d.id
`;
