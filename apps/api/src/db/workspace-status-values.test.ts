import { expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";

import {
  notValidChecksOf,
  schemaCheckCondition,
} from "@/api/tests/helpers/migration-checks";

import { workspaces } from "./schema/contacts";

const CHECK = "workspaces_status_values_check";

test("the workspace status domain check in the schema is the one its migration adds", () => {
  const added = notValidChecksOf("20261106133000_workspace_status_values");
  expect([...added.keys()]).toEqual([CHECK]);
  expect(added.get(CHECK)).toEqual({
    tableName: getTableConfig(workspaces).name,
    condition: schemaCheckCondition(workspaces, CHECK),
  });
});
