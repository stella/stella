import { useQuery } from "@tanstack/react-query";

import type { ChatRunTarget } from "@stll/api-contract/chat-run-target";

import { effectiveRunTarget } from "@/components/chat/chat-run-target-menu.logic";
import { localRunnersOptions } from "@/features/chat/queries";
import { queryView } from "@/lib/query-view.logic";

/**
 * The target a thread's next turn carries and its menu shows: the stored one,
 * held to the organization's ceiling once the member's computers are read.
 * They are read only for a thread that runs on a computer.
 */
export const useEffectiveRunTarget = (
  activeOrganizationId: string,
  stored: ChatRunTarget | undefined,
): ChatRunTarget => {
  const runnersView = queryView(
    useQuery({
      ...localRunnersOptions(activeOrganizationId),
      enabled: stored?.kind === "local",
    }),
  );
  return effectiveRunTarget(
    stored,
    runnersView.type === "items" ? runnersView.items : undefined,
  );
};
