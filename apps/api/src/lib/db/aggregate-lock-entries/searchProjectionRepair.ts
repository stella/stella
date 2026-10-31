import type { SearchProjectionKind } from "@/api/db/schema";

import type { AggregateLockDefinition } from "../aggregate-lock-definition";

export default {
  rank: 540,
  kind: "row",
} as const satisfies AggregateLockDefinition;

export type Identity = {
  kind: SearchProjectionKind;
  revision: string;
  sourceId: string;
};
