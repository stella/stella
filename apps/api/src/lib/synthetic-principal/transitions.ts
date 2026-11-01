import { syntheticSessionControl } from "@/api/db/schema";
import { defineTransitions } from "@/api/lib/db/transitions";

export const SYNTHETIC_SESSION_CONTROL_TRANSITIONS = defineTransitions(
  syntheticSessionControl,
  {
    enabled: ["revoked"],
    revoked: [],
  },
  { terminal: ["revoked"] },
);
