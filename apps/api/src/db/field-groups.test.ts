import { expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";

import {
  notValidChecksOf,
  schemaCheckCondition,
} from "@/api/tests/helpers/migration-checks";

import { schedulerJobs } from "./schema/contacts";

const CHECK = "scheduler_jobs_lease_fields_check";

test("the scheduler lease check in the schema is the one its migration adds", () => {
  const added = notValidChecksOf("20261106103000_scheduler_job_lease_fields");
  expect([...added.keys()]).toEqual([CHECK]);
  expect(added.get(CHECK)).toEqual({
    tableName: getTableConfig(schedulerJobs).name,
    condition: schemaCheckCondition(schedulerJobs, CHECK),
  });
});
