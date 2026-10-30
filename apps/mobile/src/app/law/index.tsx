import { Stack } from "expo-router";
import { View } from "react-native";
import { useTranslations } from "use-intl";

import { CaseLawList } from "@/components/case-law-list";
import { screenStyles } from "@/components/empty-state-screen";
import {
  HeaderSearchProvider,
  useHeaderSearch,
} from "@/components/header-search";
import { useSession } from "@/connection/session-provider";
import { useAppColors } from "@/theme";

/**
 * The public case law of the signed-in server, opened from More. Its search
 * is its own, in the system's field under the title, not the tabs' one.
 */
const LawScreen = () => {
  const colors = useAppColors();
  const { state } = useSession();

  return (
    <HeaderSearchProvider activeTab="law">
      <LawSearchField />
      <View
        style={[screenStyles.screen, { backgroundColor: colors.background }]}
      >
        {state.status === "signed-in" ? (
          <CaseLawList serverUrl={state.source.session().serverUrl} />
        ) : null}
      </View>
    </HeaderSearchProvider>
  );
};

export default LawScreen;

const LawSearchField = () => {
  const header = useTranslations("header");
  const { searchBar, setQuery, setSearching } = useHeaderSearch();

  return (
    <Stack.Screen
      options={{
        headerSearchBarOptions: {
          autoCapitalize: "none",
          hideWhenScrolling: false,
          onClose: () => {
            setSearching(false);
          },
          onChangeText: (event) => {
            setQuery(event.nativeEvent.text);
          },
          onOpen: () => {
            setSearching(true);
          },
          placeholder: header("search"),
          ref: searchBar,
        },
      }}
    />
  );
};
