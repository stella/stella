import { STATUS_COLUMNS } from "../../apps/api/src/lib/db/status-tables.gen.ts";
import { SANCTIONS_MONITORING_TRANSITION_IDENTITIES } from "../../apps/api/src/lib/lists/sanctions/monitoring-transition-identities.ts";
import type { OwnershipEntry } from "../ownership-types.ts";

const statusTransitionColumns = () => {
  const columns = new Map(
    Object.entries(STATUS_COLUMNS).map(([table, names]) => [
      table,
      new Set<string>(names),
    ]),
  );
  for (const { tableName, stateColumn } of Object.values(
    SANCTIONS_MONITORING_TRANSITION_IDENTITIES,
  )) {
    const names = columns.get(tableName) ?? new Set<string>();
    names.add(stateColumn);
    columns.set(tableName, names);
  }
  return Object.fromEntries(
    [...columns].map(([table, names]) => [table, [...names].toSorted()]),
  );
};

const STATUS_TRANSITION_COLUMNS = statusTransitionColumns();

export default {
  id: "status-transition",
  capability: "Changing a row's lifecycle state",
  owner: ["apps/api/src/lib/db/transitions.ts"],
  summary:
    "The transition owner checks the expected state and optional fence in the update predicate, and returns Transitioned or Stale. A required recorder audits successful updates in the caller's transaction; stale updates record nothing and recorder failure rolls the update back. Direct lifecycle writes, conflict updates and visible SQL lifecycle assignments are lint errors outside the measured backlog; per-file shrink-only guards forbid adding them. Opaque table handles and payloads count conservatively. Unmanaged declarations shrink independently per table. SQL built entirely by external functions, external payload mutation and custom SQL column names not ending in status/state/phase remain outside static inspection.",
  enforcement: {
    kind: "status-set",
    columns: STATUS_TRANSITION_COLUMNS,
    allowed: [],
  },
} as const satisfies OwnershipEntry;
