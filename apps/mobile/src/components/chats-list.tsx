import { Suspense, useState, useTransition } from "react";

import { Result } from "better-result";
import { ActivityIndicator, StyleSheet } from "react-native";

import { LoadedChats } from "@/components/loaded-chats";
import { epochMilliseconds } from "@/connection/clock";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import type { Load } from "@/state/api-request";
import { listChatThreads } from "@/state/chat-threads";
import type { ChatThreadsPage } from "@/state/chat-threads";
import { useAppColors } from "@/theme";

/** Loads the signed-in person's recent threads once, and again on every pull to refresh. */
export const ChatsList = ({ source }: { source: AccessTokenSource }) => {
  const colors = useAppColors();
  const { end } = useSession();
  const loadThreads = async (): Promise<Load<ChatThreadsPage>> => {
    const result = await listChatThreads({ fetch, source });
    if (Result.isError(result) && result.error._tag === "SignedOutError") {
      end(source);
    }
    return { loadedAt: epochMilliseconds(), result };
  };
  const [load, setLoad] = useState(loadThreads);
  const [refreshing, startRefresh] = useTransition();
  const reload = () => {
    startRefresh(() => {
      setLoad(loadThreads());
    });
  };

  return (
    <Suspense
      fallback={
        <ActivityIndicator color={colors.accent} style={styles.loading} />
      }
    >
      <LoadedChats
        load={load}
        onReload={reload}
        refreshing={refreshing}
        source={source}
      />
    </Suspense>
  );
};

const styles = StyleSheet.create({
  loading: {
    flex: 1,
  },
});
