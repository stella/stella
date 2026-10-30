import { panic } from "better-result";

import { allSchemaTableNames } from "@/api/lib/account-export/schema-census";
import type { SchemaTableName } from "@/api/lib/account-export/schema-census";

export type SchedulerTableName = SchemaTableName;

export type SchedulerTableAccess = {
  reads: readonly SchedulerTableName[];
  writes: readonly SchedulerTableName[];
};

export const allSchedulerTableNames = allSchemaTableNames;

type TableDeclarationCandidate = {
  id: string;
  tables?: { reads?: readonly string[]; writes?: readonly string[] };
};

/** Validate declarations from fixtures and persisted/configured boundaries too. */
export const assertSchedulerTableDeclarations = (
  jobs: readonly TableDeclarationCandidate[],
): void => {
  const names = allSchemaTableNames();
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
