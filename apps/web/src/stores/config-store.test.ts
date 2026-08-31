import { describe, expect, test } from "bun:test";

import {
  CONFIG_STORE_VERSION,
  migratePersistedConfigState,
  toPersistedConfigState,
  useConfigStore,
} from "@/stores/config-store";

describe("persisted Matter preferences", () => {
  test("retains presentation preferences without organization-scoped visibility", () => {
    const state = useConfigStore.getState();
    const persisted = toPersistedConfigState({
      ...state,
      matters: {
        ...state.matters,
        clientFilter: "client_previous_organization",
        collapsedGroups: ["client_previous_organization"],
        filters: {
          client: ["client_previous_organization"],
          team: ["user_previous_organization"],
        },
        hiddenColumns: ["team"],
        sortDesc: false,
        sortKey: "name",
        viewMode: "table",
      },
    });

    expect(CONFIG_STORE_VERSION).toBe(2);
    expect(persisted.matters).toMatchObject({
      clientFilter: null,
      collapsedGroups: [],
      filters: {},
      hiddenColumns: ["team"],
      sortDesc: false,
      sortKey: "name",
      viewMode: "table",
    });
  });

  test("migrates legacy preferences without stale visibility state", () => {
    const migrated = migratePersistedConfigState({
      matters: {
        clientFilter: "client_previous_organization",
        collapsedGroups: ["client_previous_organization"],
        filters: { team: ["user_previous_organization"] },
        groupBy: "none",
        hiddenColumns: ["team", "not-a-column"],
        sortDesc: false,
        sortKey: "name",
        viewMode: "table",
      },
    });

    expect(migrated.matters).toEqual({
      clientFilter: null,
      collapsedGroups: [],
      filters: {},
      groupBy: "none",
      hiddenColumns: ["team"],
      sortDesc: false,
      sortKey: "name",
      viewMode: "table",
    });
  });
});
