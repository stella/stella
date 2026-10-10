import { describe, expect, test } from "bun:test";

import {
  ACCOUNT_EXPORT_REGISTRY,
  assertAccountExportRegistry,
} from "./registry";
import { userOwnedTableNames } from "./schema-census";
import { USER_OWNED_TABLE_NAMES } from "./user-owned-tables.gen";

describe("personal data export coverage", () => {
  test("every schema-owned table has an explicit disposition", () => {
    const tableNames = userOwnedTableNames();
    expect(tableNames).toEqual([...USER_OWNED_TABLE_NAMES]);
    expect(Object.keys(ACCOUNT_EXPORT_REGISTRY).toSorted()).toEqual(tableNames);
    assertAccountExportRegistry({
      tableNames,
      registry: ACCOUNT_EXPORT_REGISTRY,
    });
  });

  test("removing any disposition fails the coverage invariant", () => {
    const tableNames = userOwnedTableNames();
    for (const omitted of tableNames) {
      const registry = Object.fromEntries(
        Object.entries(ACCOUNT_EXPORT_REGISTRY).filter(
          ([table]) => table !== omitted,
        ),
      );
      expect(() =>
        assertAccountExportRegistry({ tableNames, registry }),
      ).toThrow("disposition missing");
    }
  });

  test("unowned tables and another owner's projection fail the guard", () => {
    const tableNames = userOwnedTableNames();
    expect(() =>
      assertAccountExportRegistry({
        tableNames,
        registry: {
          ...ACCOUNT_EXPORT_REGISTRY,
          unowned_table: { type: "exempt", reason: "org-owned" },
        },
      }),
    ).toThrow("no user table");
    expect(() =>
      assertAccountExportRegistry({
        tableNames,
        registry: {
          ...ACCOUNT_EXPORT_REGISTRY,
          user: ACCOUNT_EXPORT_REGISTRY.saved_searches,
        },
      }),
    ).toThrow("another owner");
  });
});
