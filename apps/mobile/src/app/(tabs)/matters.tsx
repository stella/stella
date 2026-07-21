import { useState } from "react";

import { StyleSheet, TextInput } from "react-native";

import { EmptyStateScreen } from "@/components/empty-state-screen";
import { useAppColors } from "@/theme";

export default function MattersScreen() {
  const colors = useAppColors();
  const [query, setQuery] = useState("");

  return (
    <EmptyStateScreen
      description="Find a matter and get the essential context quickly."
      emptyDescription="Your recent matters and matching search results will appear here."
      emptyTitle={query ? "No matching matters" : "No recent matters"}
      title="Matters"
    >
      <TextInput
        accessibilityLabel="Search matters"
        autoCapitalize="none"
        clearButtonMode="while-editing"
        onChangeText={setQuery}
        placeholder="Search matters"
        placeholderTextColor={colors.muted}
        returnKeyType="search"
        style={[
          styles.search,
          {
            backgroundColor: colors.card,
            borderColor: colors.border,
            color: colors.text,
          },
        ]}
        value={query}
      />
    </EmptyStateScreen>
  );
}

const styles = StyleSheet.create({
  search: {
    borderRadius: 14,
    borderWidth: 1,
    fontSize: 16,
    minHeight: 48,
    paddingHorizontal: 16,
  },
});
