import { panic } from "better-result";

import { SCHEMA_TABLE_NAMES } from "../../db/schema-table-names.gen";

export type SchedulerTableName = (typeof SCHEMA_TABLE_NAMES)[number];

export type SchedulerTableAccess = {
  reads: readonly SchedulerTableName[];
  writes: readonly SchedulerTableName[];
};

export const allSchedulerTableNames = () => SCHEMA_TABLE_NAMES;

type TableDeclarationCandidate = {
  id: string;
  tables?: { reads?: readonly string[]; writes?: readonly string[] };
};

/** Validate declarations from fixtures and persisted/configured boundaries too. */
export const assertSchedulerTableDeclarations = (
  jobs: readonly TableDeclarationCandidate[],
): void => {
  const names = SCHEMA_TABLE_NAMES;
  for (const { id, tables } of jobs) {
    if (
      tables === undefined ||
      tables.reads === undefined ||
      tables.writes === undefined
    ) {
      panic(`Scheduler job ${id} has no table declaration`);
    }
    for (const name of [...tables.reads, ...tables.writes]) {
      if (!names.some((existing) => existing === name)) {
        panic(`Scheduler job ${id} declares unknown table ${name}`);
      }
    }
  }
};
