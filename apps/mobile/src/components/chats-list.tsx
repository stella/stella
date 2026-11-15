import { Suspense, useState, useTransition } from "react";

import { Result } from "better-result";
import { ActivityIndicator } from "react-native";

import { SEARCH_QUERY_MAX_LENGTH } from "@stll/api-contract/limits";

import { useActiveChatRuns } from "@/components/active-chat-runs";
import { useRevisedLoad } from "@/components/changes";
import { useHeaderSearch } from "@/components/header-search";
import { LoadedChats } from "@/components/loaded-chats";
import type { ChatsLoad } from "@/components/loaded-chats";
import { epochMilliseconds } from "@/connection/clock";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import { listChats } from "@/state/chat-threads";
import { useAppColors } from "@/theme";

/**
 * Loads the signed-in person's pinned and recent threads once, again on
 * every pull to refresh, once typing pauses in the header's search field,
 * and in place whenever a chat is marked here or on another device, with
 * their unfinished runs beside them, so chats waiting on the person and
 * chats working head the list. A new conversation starts from the header's
 * button, as t3code's does.
 */
export const ChatsList = ({ source }: { source: AccessTokenSource }) => {
  const colors = useAppColors();
  const { settledQuery } = useHeaderSearch();
  const searched = settledQuery.slice(0, SEARCH_QUERY_MAX_LENGTH);
  const { end } = useSession();
  const activeRuns = useActiveChatRuns();
  const loadThreads = async (search: string): Promise<ChatsLoad> => {
    const result = await listChats({ fetch, search, source });
    if (Result.isError(result) && result.error._tag === "SignedOutError") {
      end(source);
    }
    // The text a load asked for travels with it, so an empty result names it.
    return { loadedAt: epochMilliseconds(), result, search };
  };
  const [load, setLoad] = useRevisedLoad(
    async () => await loadThreads(searched),
    ["chats"],
  );
  const [asked, setAsked] = useState(searched);
  const [refreshing, startRefresh] = useTransition();
  // A settled search the showing load did not ask for starts the next one.
  if (searched !== asked) {
    setAsked(searched);
    setLoad(loadThreads(searched));
  }

  const reload = () => {
    activeRuns.reread();
    startRefresh(() => {
      setLoad(loadThreads(searched));
    });
  };

  return (
    <Suspense
      fallback={<ActivityIndicator className="flex-1" color={colors.muted} />}
    >
      <LoadedChats
        load={load}
        onReload={reload}
        onRetryRuns={activeRuns.reread}
        refreshing={refreshing}
        runs={activeRuns.runs}
        source={source}
      />
    </Suspense>
  );
};
