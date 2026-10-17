import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "observed-mutation-state",
  capability:
    "Reading mutation-cache state with the caller's submitted variables",
  owner: ["apps/web/src/lib/idempotency/use-observed-mutation-state.ts"],
  summary:
    "Create mutations retain transport intent in an internal envelope. useObservedMutationState projects the caller's variables before selectors read mutation-cache state, so save indicators and optimistic state do not depend on transport representation.",
  enforcement: {
    kind: "import",
    specifiers: ["@tanstack/react-query"],
    names: ["useMutationState"],
    allowed: [],
  },
} as const satisfies OwnershipEntry;
