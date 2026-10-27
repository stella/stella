import { Suspense, useEffect, useRef, useState, useTransition } from "react";

import { Result } from "better-result";
import { ActivityIndicator, View } from "react-native";
import { useTranslations } from "use-intl";

import { SEARCH_QUERY_MAX_LENGTH } from "@stll/api-contract/limits";

import { ScreenHeading } from "@/components/empty-state-screen";
import { LoadedChats } from "@/components/loaded-chats";
import { NewChatButton } from "@/components/new-chat-button";
import { TextInput } from "@/components/ui/text";
import { epochMilliseconds } from "@/connection/clock";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import type { Load } from "@/state/api-request";
import { listChatThreads } from "@/state/chat-threads";
import type { ChatThreadsPage } from "@/state/chat-threads";
import { useAppColors } from "@/theme";

/** How long typing pauses before the list asks the server again. */
const SEARCH_PAUSE_MS = 300;

/**
 * Loads the signed-in person's recent threads once, again on every pull to
 * refresh, and again for what is typed in the search field. The heading and
 * the field stay outside the list, so new results never take the keyboard
 * away while typing.
 */
export const ChatsList = ({ source }: { source: AccessTokenSource }) => {
  const colors = useAppColors();
  const t = useTranslations("chat");
  const tabs = useTranslations("tabs");
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
  const [typed, setTyped] = useState("");
  // The text a load asked for travels with it, so an empty result names it.
  const [request, setRequest] = useState(() => ({
    load: loadThreads(""),
    search: "",
  }));
  const [refreshing, startRefresh] = useTransition();
  const [, startSearch] = useTransition();
  const pause = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(pause.current), []);

  const reload = () => {
    startRefresh(() => {
      setRequest({ load: loadThreads(typed), search: typed });
    });
  };
  const changeSearch = (text: string) => {
    setTyped(text);
    clearTimeout(pause.current);
    pause.current = setTimeout(() => {
      startSearch(() => {
        setRequest({ load: loadThreads(text), search: text });
      });
    }, SEARCH_PAUSE_MS);
  };

  return (
    <View className="flex-1">
      <View className="gap-3 px-4 pt-6">
        <ScreenHeading description={t("description")} title={tabs("chat")} />
        <TextInput
          accessibilityLabel={t("search")}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          maxLength={SEARCH_QUERY_MAX_LENGTH}
          onChangeText={changeSearch}
          placeholder={t("search")}
          returnKeyType="search"
          variant="search"
          value={typed}
        />
        <NewChatButton />
      </View>
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
    </View>
  );
};
