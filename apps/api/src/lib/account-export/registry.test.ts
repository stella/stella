import { describe, expect, test } from "bun:test";

import { ACCOUNT_EXPORT_PROJECTIONS } from "@/api/account-export-projections";

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
      projections: ACCOUNT_EXPORT_PROJECTIONS,
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
        assertAccountExportRegistry({
          tableNames,
          registry,
          projections: ACCOUNT_EXPORT_PROJECTIONS,
        }),
      ).toThrow("disposition missing");
    }
  });

  test("unowned tables and unbound or misplaced projections fail the guard", () => {
    const tableNames = userOwnedTableNames();
    expect(() =>
      assertAccountExportRegistry({
        tableNames,
        registry: {
          ...ACCOUNT_EXPORT_REGISTRY,
          unowned_table: { type: "exempt", reason: "org-owned" },
        },
        projections: ACCOUNT_EXPORT_PROJECTIONS,
      }),
    ).toThrow("no user table");
    const { saved_searches: _unbound, ...withoutSavedSearches } =
      ACCOUNT_EXPORT_PROJECTIONS;
    expect(() =>
      assertAccountExportRegistry({
        tableNames,
        registry: ACCOUNT_EXPORT_REGISTRY,
        projections: withoutSavedSearches,
      }),
    ).toThrow("does not match its disposition: saved_searches");
    expect(() =>
      assertAccountExportRegistry({
        tableNames,
        registry: ACCOUNT_EXPORT_REGISTRY,
        projections: {
          ...ACCOUNT_EXPORT_PROJECTIONS,
          account: ACCOUNT_EXPORT_PROJECTIONS.user,
        },
      }),
    ).toThrow("does not match its disposition: account");
    expect(() =>
      assertAccountExportRegistry({
        tableNames,
        registry: ACCOUNT_EXPORT_REGISTRY,
        projections: {
          ...ACCOUNT_EXPORT_PROJECTIONS,
          unowned_table: ACCOUNT_EXPORT_PROJECTIONS.user,
        },
      }),
    ).toThrow("has no disposition: unowned_table");
  });
});
