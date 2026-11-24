import { useState } from "react";

import type { MatterVisibility } from "@stll/api-contract/matter-visibility";

import {
  FOLLOW_CLIENT_VISIBILITY,
  newMatterVisibility,
} from "@/components/workspaces/matter-visibility.logic";

/**
 * The visibility a new matter is created with: the default for whether it
 * has a client, re-derived as the client field changes, until the person
 * picks a level.
 */
export const useNewMatterVisibility = (hasClient: boolean) => {
  const [choice, setChoice] = useState(FOLLOW_CLIENT_VISIBILITY);

  return {
    choice,
    visibility: newMatterVisibility({ choice, hasClient }),
    choose: (visibility: MatterVisibility) => {
      setChoice({ type: "chosen", visibility });
    },
    reset: () => {
      setChoice(FOLLOW_CLIENT_VISIBILITY);
    },
  };
};
