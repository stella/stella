import { expect, test } from "bun:test";
import { pgTable, text, integer } from "drizzle-orm/pg-core";

import { statusColumns } from "./generate-status-tables";

test("a new lifecycle column enters the inventory without a hand-maintained table list", () => {
  const table = pgTable("inventory_fixture", {
    id: text().primaryKey(),
    status: text(),
    workStatus: text(),
    seedState: text(),
    phase: integer(),
    name: text(),
  });
  expect(statusColumns({ constant: "unused", newTable: table })).toEqual({
    newTable: ["phase", "seedState", "status", "workStatus"],
  });
});
