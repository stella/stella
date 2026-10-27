import { Suspense, useState, useTransition } from "react";

import { Result } from "better-result";
import { ActivityIndicator } from "react-native";

import { SEARCH_QUERY_MAX_LENGTH } from "@stll/api-contract/limits";

import { useHeaderSearch } from "@/components/header-search";
import { LoadedChats } from "@/components/loaded-chats";
import { epochMilliseconds } from "@/connection/clock";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import type { Load } from "@/state/api-request";
import { listChatThreads } from "@/state/chat-threads";
import type { ChatThreadsPage } from "@/state/chat-threads";
import { useAppColors } from "@/theme";

/**
 * Loads the signed-in person's recent threads once, again on every pull to
 * refresh, and again once typing pauses in the header's search field. A new
 * conversation starts from the header's button, as t3code's does.
 */
export const ChatsList = ({ source }: { source: AccessTokenSource }) => {
  const colors = useAppColors();
  const { settledQuery } = useHeaderSearch();
  const searched = settledQuery.slice(0, SEARCH_QUERY_MAX_LENGTH);
  const { end } = useSession();
  const loadThreads = async (
    search: string,
  ): Promise<Load<ChatThreadsPage>> => {
    const result = await listChatThreads({ fetch, search, source });
    if (Result.isError(result) && result.error._tag === "SignedOutError") {
      end();
    }
    return { loadedAt: epochMilliseconds(), result };
  };
  // The text a load asked for travels with it, so an empty result names it.
  const [request, setRequest] = useState(() => ({
    load: loadThreads(""),
    search: "",
  }));
  const [refreshing, startRefresh] = useTransition();
  // A settled search the showing load did not ask for starts the next one.
  if (searched !== request.search) {
    setRequest({ load: loadThreads(searched), search: searched });
  }

  const reload = () => {
    startRefresh(() => {
      setRequest({ load: loadThreads(searched), search: searched });
    });
  };

  return (
    <Suspense
      fallback={<ActivityIndicator className="flex-1" color={colors.muted} />}
    >
      <LoadedChats
        load={request.load}
        onReload={reload}
        refreshing={refreshing}
        search={request.search}
        source={source}
      />
    </Suspense>
  );
};
