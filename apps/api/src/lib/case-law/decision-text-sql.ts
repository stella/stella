import { sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";

import {
  DECISION_TEXT_ABSENCE_METADATA_KEY,
  DECISION_TEXT_FIELD_KEYS,
  TEXT_ABSENCE_REASON,
  TEXT_ABSENCE_REASONS,
} from "@stll/api-contract/case-law-text-field";

const STORED_TEXT_ABSENCE_REASONS = TEXT_ABSENCE_REASONS.filter(
  (reason) => reason !== TEXT_ABSENCE_REASON.NOT_PUBLISHED,
);

const jsonKey = (key: string): SQL => sql.raw(`'${key.replaceAll("'", "''")}'`);

const sqlTextList = (values: readonly string[]): SQL =>
  sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );

export const storedDecisionTextAbsenceEntriesSql = (
  metadata: SQLWrapper,
): SQL =>
  sql`CASE jsonb_typeof(
        ${metadata} -> ${jsonKey(DECISION_TEXT_ABSENCE_METADATA_KEY)}
      )
        WHEN 'array' THEN
          ${metadata} -> ${jsonKey(DECISION_TEXT_ABSENCE_METADATA_KEY)}
        ELSE '[]'::jsonb
      END`;

export const storedDecisionTextAbsenceValidSql = (
  metadata: SQLWrapper,
  entries: SQLWrapper,
): SQL => sql`CASE
  WHEN NOT coalesce(
    ${metadata} ? ${jsonKey(DECISION_TEXT_ABSENCE_METADATA_KEY)},
    false
  ) THEN true
  WHEN jsonb_typeof(
    ${metadata} -> ${jsonKey(DECISION_TEXT_ABSENCE_METADATA_KEY)}
  ) <> 'array' THEN false
  ELSE
    NOT EXISTS (
      SELECT 1
        FROM jsonb_array_elements(${entries}) AS absence_item(entry)
       WHERE CASE jsonb_typeof(absence_item.entry)
         WHEN 'object' THEN
           (SELECT count(*) FROM jsonb_object_keys(absence_item.entry)) <> 2
           OR NOT (absence_item.entry ? 'field')
           OR NOT (absence_item.entry ? 'reason')
           OR jsonb_typeof(absence_item.entry -> 'field') <> 'string'
           OR jsonb_typeof(absence_item.entry -> 'reason') <> 'string'
           OR absence_item.entry ->> 'field' NOT IN (
             ${sqlTextList(DECISION_TEXT_FIELD_KEYS)}
           )
           OR absence_item.entry ->> 'reason' NOT IN (
             ${sqlTextList(STORED_TEXT_ABSENCE_REASONS)}
           )
         ELSE true
       END
    )
    AND (
      SELECT count(*) = count(DISTINCT absence_item.entry ->> 'field')
        FROM jsonb_array_elements(${entries}) AS absence_item(entry)
       WHERE jsonb_typeof(absence_item.entry) = 'object'
    )
END`;
