import { useQuery } from "@tanstack/react-query";

import type { ChatRunTarget } from "@stll/api-contract/chat-run-target";

import {
  effectiveRunTarget,
  runTargetNeedsCeiling,
} from "@/components/chat/chat-run-target-menu.logic";
import { localRunnersOptions } from "@/features/chat/queries";
import { queryView } from "@/lib/query-view.logic";

/**
 * The target a thread's next turn carries and its menu shows: the stored one,
 * held to the organization's ceiling once it is read. It is read for a
 * thread that runs on a computer, or on stella's models above the lowest
 * ceiling.
 */
export const useEffectiveRunTarget = (
  activeOrganizationId: string,
  stored: ChatRunTarget | undefined,
): ChatRunTarget => {
  const runnersView = queryView(
    useQuery({
      ...localRunnersOptions(activeOrganizationId),
      enabled: runTargetNeedsCeiling(stored),
    }),
  );
  return effectiveRunTarget(
    stored,
    runnersView.type === "items" ? runnersView.items : undefined,
  );
};
