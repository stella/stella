import { Suspense, useState, useTransition } from "react";

import { Result } from "better-result";
import { ActivityIndicator, StyleSheet } from "react-native";

import { LoadedMatters } from "@/components/loaded-matters";
import { epochMilliseconds } from "@/connection/clock";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import { listMatters } from "@/state/matters";
import type { MattersLoad } from "@/state/matters";
import { useAppColors } from "@/theme";

/** Loads the signed-in person's matters once, and again on every pull to refresh. */
export const MattersList = ({ source }: { source: AccessTokenSource }) => {
  const colors = useAppColors();
  const { end } = useSession();
  // A session the server ended sends the person back to sign in, from the
  // load itself rather than from a render.
  const loadMatters = async (): Promise<MattersLoad> => {
    const result = await listMatters({ fetch, source });
    if (Result.isError(result) && result.error._tag === "SignedOutError") {
      end();
    }
    return { loadedAt: epochMilliseconds(), result };
  };
  const [load, setLoad] = useState(loadMatters);
  const [refreshing, startRefresh] = useTransition();
  const reload = () => {
    startRefresh(() => {
      setLoad(loadMatters());
    });
  };

  return (
    <Suspense
      fallback={
        <ActivityIndicator color={colors.accent} style={styles.loading} />
      }
    >
      <LoadedMatters load={load} onReload={reload} refreshing={refreshing} />
    </Suspense>
  );
};

const styles = StyleSheet.create({
  loading: {
    flex: 1,
  },
});
