import { describe, expect, test } from "bun:test";

import {
  compareCatalogs,
  digestColumnNames,
  ledgerPairs,
  rowsByKey,
  seedFootprint,
} from "./migration-catalog";

describe("migration catalog", () => {
  test("column attnum order is not a difference", () => {
    const id = { schema: "public", table: "items", name: "id", type: "uuid" };
    const name = {
      schema: "public",
      table: "items",
      name: "name",
      type: "text",
    };
    const left = {
      columns: rowsByKey([id, name], ["schema", "table", "name"]),
    };
    const right = {
      columns: rowsByKey([name, id], ["schema", "table", "name"]),
    };
    expect(compareCatalogs(left, right)).toEqual([]);
  });

  test("a policy qual difference is reported at the policy", () => {
    const left = {
      policies: { "public.items.read": { qual: "tenant_id = 1" } },
    };
    const right = { policies: { "public.items.read": { qual: "true" } } };
    expect(compareCatalogs(left, right)).toEqual([
      'policies.public.items.read.qual: "tenant_id = 1" != "true"',
    ]);
  });

  test("enum label order is reported", () => {
    const left = { enums: { "public.status": ["new", "done"] } };
    const right = { enums: { "public.status": ["done", "new"] } };
    expect(compareCatalogs(left, right)).toEqual([
      'enums.public.status[0]: "new" != "done"',
      'enums.public.status[1]: "done" != "new"',
    ]);
  });

  test("volatile-default columns are excluded from data digests", () => {
    expect(
      digestColumnNames([
        { name: "id", default: "gen_random_uuid()" },
        { name: "created_at", default: "now()" },
        { name: "sequence", default: "nextval('items_id_seq'::regclass)" },
        { name: "status", default: "'new'::text" },
        { name: "value", default: null },
      ]),
    ).toEqual(["status", "value"]);
  });

  test("ledger is a name and hash set, independent of receipt id and timestamp", () => {
    const leftRows = [
      { name: "b", hash: "2", id: 1, applied_at: "yesterday" },
      { name: "a", hash: "1", id: 2, applied_at: "yesterday" },
      { name: "a", hash: "1", id: 3, applied_at: "today" },
    ];
    const rightRows = [
      { name: "a", hash: "1", id: 9, applied_at: "today" },
      { name: "b", hash: "2", id: 8, applied_at: "today" },
    ];
    const left = ledgerPairs(leftRows);
    const right = ledgerPairs(rightRows);
    expect(left).toEqual(right);
    expect(compareCatalogs({ ledger: left }, { ledger: right })).toEqual([]);
    expect(
      compareCatalogs(
        { ledger: left },
        { ledger: ledgerPairs([{ name: "a", hash: "other" }]) },
      ),
    ).not.toEqual([]);
  });

  test("seed footprint includes indirect writes and only masks cross-path row comparison", () => {
    const before = {
      data: {
        "public.direct": "0:empty",
        "public.via_trigger": "0:empty",
        "public.other": "1:same",
      },
    };
    const after = {
      data: {
        "public.direct": "1:seed",
        "public.via_trigger": "1:derived",
        "public.other": "1:same",
      },
    };
    const footprint = seedFootprint(before, after);
    expect(footprint).toEqual(["public.direct", "public.via_trigger"]);
    expect(compareCatalogs(after, before, new Set(footprint))).toEqual([]);
    expect(compareCatalogs(after, before)).toHaveLength(2);
    expect(
      compareCatalogs(
        after,
        { data: { ...after.data, "public.other": "1:drift" } },
        new Set(footprint),
      ),
    ).toEqual(['data.public.other: "1:same" != "1:drift"']);
  });
});
