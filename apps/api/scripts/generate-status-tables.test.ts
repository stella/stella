import { expect, test } from "bun:test";
import { integer, pgTable, pgView, text } from "drizzle-orm/pg-core";

import { statusColumnMaps } from "./generate-status-tables";

test("a new lifecycle column enters the inventory without a hand-maintained table list", () => {
  const table = pgTable("inventory_fixture", {
    id: text().primaryKey(),
    status: text(),
    workStatus: text(),
    seedState: text(),
    phase: integer(),
    name: text(),
  });
  const view = pgView("inventory_view").as((qb) => qb.select().from(table));
  const maps = statusColumnMaps({
    constant: "unused",
    newTable: table,
    inventoryView: view,
  });
  expect(maps.statusColumns).toEqual({
    newTable: ["phase", "seedState", "status", "workStatus"],
    inventoryView: ["phase", "seedState", "status", "workStatus"],
  });
  expect(maps.writableStatusColumns).toEqual({
    newTable: ["phase", "seedState", "status", "workStatus"],
  });
});
