import type { SafeId } from "@/api/lib/branded-types";

import type { AggregateLockDefinition } from "../aggregate-lock-definition";

export default {
  rank: 110,
  kind: "row",
  holder: "application",
} as const satisfies AggregateLockDefinition;

export type Identity =
  | {
      type: "organization-member";
      id: string;
      organizationId: SafeId<"organization">;
    }
  | {
      type: "workspace-member";
      id: string;
      workspaceId: SafeId<"workspace">;
    };
