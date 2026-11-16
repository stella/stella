import { Suspense, useTransition } from "react";

import { Result } from "better-result";
import { ActivityIndicator } from "react-native";

import { useRevisedLoad } from "@/components/changes";
import { LoadedMatters } from "@/components/loaded-matters";
import { epochMilliseconds } from "@/connection/clock";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import { listMatters } from "@/state/matters";
import type { MattersLoad } from "@/state/matters";
import { listTimers } from "@/state/timers";
import { useAppColors } from "@/theme";

/**
 * Loads the signed-in person's matters once, again on every pull to
 * refresh, and afresh after a matter is opened from the header's "+"; their
 * timers beside them, for each row's timer swipe, afresh after any timer
 * changes.
 */
export const MattersList = ({ source }: { source: AccessTokenSource }) => (
  <MattersLoader source={source} />
);

const MattersLoader = ({ source }: { source: AccessTokenSource }) => {
  const colors = useAppColors();
  const { end } = useSession();
  // A session the server ended sends the person back to sign in, from the
  // load itself rather than from a render.
  const loadMatters = async (): Promise<MattersLoad> => {
    const result = await listMatters({ fetch, source });
    if (Result.isError(result) && result.error._tag === "SignedOutError") {
      end(source);
    }
    return { loadedAt: epochMilliseconds(), result };
  };
  const loadTimers = async () => await listTimers({ fetch, source });
  const [load, setLoad] = useRevisedLoad(loadMatters, ["matters"]);
  const [timers, setTimers] = useRevisedLoad(loadTimers, ["timers"]);
  const [refreshing, startRefresh] = useTransition();
  const reload = () => {
    startRefresh(() => {
      setLoad(loadMatters());
      setTimers(loadTimers());
    });
  };

  return (
    <Suspense
      fallback={<ActivityIndicator className="flex-1" color={colors.muted} />}
    >
      <LoadedMatters
        load={load}
        onReload={reload}
        refreshing={refreshing}
        source={source}
        timers={timers}
      />
    </Suspense>
  );
};
