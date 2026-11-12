import { useSyncExternalStore } from "react";

import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { Result, TaggedError } from "better-result";

import { getDesktopLaunch } from "@/features/chat/desktop-launch";
import {
  type DesktopLaunchOutcome,
  type DesktopLaunchState,
  hasConnectedComputer,
  type ReadComputerConnected,
} from "@/features/chat/desktop-launch.logic";
import { localRunnersOptions } from "@/features/chat/queries";
import { useLatestCallback } from "@/hooks/use-latest-callback";

class ComputerReadError extends TaggedError("ComputerReadError")<{
  message: string;
  cause: unknown;
}> {}

/**
 * Reads the member's computers afresh into the cache, so the Run on menu and
 * the composer bar show a computer the moment it connects.
 */
const readComputerConnected =
  (
    queryClient: QueryClient,
    activeOrganizationId: string,
  ): ReadComputerConnected =>
  async () =>
    (
      await Result.tryPromise({
        try: async () =>
          await queryClient.fetchQuery({
            ...localRunnersOptions(activeOrganizationId),
            staleTime: 0,
          }),
        catch: (cause) =>
          new ComputerReadError({
            message: "The member's computers could not be read",
            cause,
          }),
      })
    ).map(hasConnectedComputer);

type UseDesktopLaunchResult = {
  state: DesktopLaunchState;
  /**
   * Opens stella desktop and waits for a computer to connect. Call it only
   * synchronously inside the member's click or key press.
   */
  launch: () => Promise<DesktopLaunchOutcome>;
};

export const useDesktopLaunch = (
  activeOrganizationId: string,
): UseDesktopLaunchResult => {
  const queryClient = useQueryClient();
  const desktop = getDesktopLaunch();
  const state = useSyncExternalStore(desktop.subscribe, desktop.state);
  const launch = useLatestCallback(
    async () =>
      await desktop.launch(
        readComputerConnected(queryClient, activeOrganizationId),
      ),
  );
  return { state, launch };
};
