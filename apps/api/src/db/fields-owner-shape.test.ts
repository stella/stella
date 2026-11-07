import { expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";

import {
  notValidChecksOf,
  schemaCheckCondition,
} from "@/api/tests/helpers/migration-checks";

import { fields } from "./schema/entities";

const CHECKS = ["fields_owner_fields_check", "fields_owner_pending_check"];

test("the cell ownership checks in the schema are the ones their migration adds", () => {
  const added = notValidChecksOf("20261107190000_fields_owner_shape");
  expect([...added.keys()].toSorted()).toEqual(CHECKS.toSorted());
  for (const name of CHECKS) {
    expect(added.get(name)).toEqual({
      tableName: getTableConfig(fields).name,
      condition: schemaCheckCondition(fields, name),
    });
  }
});
