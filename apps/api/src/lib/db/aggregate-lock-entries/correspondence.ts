import type { SafeId } from "@/api/lib/branded-types";

import type { AggregateLockDefinition } from "../aggregate-lock-definition";

// A record's source set changes under its row lock. Filing holds the source
// file first, and entity deletion locks the file before its trigger locks the
// record, so the record ranks after the entity.
export default {
  rank: 505,
  kind: "row",
} as const satisfies AggregateLockDefinition;

export type Identity = {
  id: SafeId<"correspondence">;
  workspaceId: SafeId<"workspace">;
};
