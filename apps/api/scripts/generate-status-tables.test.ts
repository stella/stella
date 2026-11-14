import { expect, test } from "bun:test";
import { integer, pgTable, pgView, text } from "drizzle-orm/pg-core";

import { ENUM_COLUMN_ROLE } from "../src/lib/db/enum-column-roles";
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
  const maps = statusColumnMaps(
    { constant: "unused", newTable: table, inventoryView: view },
    {},
  );
  expect(maps.statusColumns).toEqual({
    newTable: ["phase", "seedState", "status", "workStatus"],
    inventoryView: ["phase", "seedState", "status", "workStatus"],
  });
  expect(maps.writableStatusColumns).toEqual({
    newTable: ["phase", "seedState", "status", "workStatus"],
  });
});

test("an enum column joins the inventory by its role, not its name", () => {
  const table = pgTable("role_fixture", {
    id: text().primaryKey(),
    connection: text({ enum: ["connected", "disconnected"] }),
    channel: text("delivery_channel", { enum: ["email", "post"] }),
  });
  // Roles name the SQL table and column; the inventory keeps the export's keys.
  const maps = statusColumnMaps(
    { roleTable: table },
    {
      role_fixture: {
        connection: ENUM_COLUMN_ROLE.lifecycle,
        delivery_channel: ENUM_COLUMN_ROLE.attribute,
      },
    },
  );
  expect(maps.writableStatusColumns).toEqual({ roleTable: ["connection"] });
  expect(maps.enumColumns).toEqual({
    role_fixture: ["connection", "delivery_channel"],
  });
});

test("an unclassified enum column stops the inventory", () => {
  const table = pgTable("unclassified_fixture", {
    id: text().primaryKey(),
    stage: text({ enum: ["draft", "final"] }),
  });
  expect(() => statusColumnMaps({ stagedTable: table }, {})).toThrow(
    "Classify unclassified_fixture.stage",
  );
});
