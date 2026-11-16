import { expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";

import {
  notValidChecksOf,
  schemaCheckCondition,
} from "@/api/tests/helpers/migration-checks";

import { flowRuns, flowRunSteps } from "./schema/flows";

test("every state-fields check in the schema is the one its migration adds", () => {
  const added = notValidChecksOf("20261106091500_flow_run_state_fields");
  const cases = [
    { table: flowRuns, name: "flow_runs_state_fields_check" },
    { table: flowRunSteps, name: "flow_run_steps_state_fields_check" },
  ];
  expect([...added.keys()].toSorted()).toEqual(
    cases.map(({ name }) => name).toSorted(),
  );
  for (const { table, name } of cases) {
    expect(added.get(name)).toEqual({
      tableName: getTableConfig(table).name,
      condition: schemaCheckCondition(table, name),
    });
  }
});
