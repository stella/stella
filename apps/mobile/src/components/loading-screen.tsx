import { ActivityIndicator, StyleSheet, View } from "react-native";

import { useAppColors } from "@/theme";

/** A full screen with one spinner, while something the screen needs loads. */
export const LoadingScreen = () => {
  const colors = useAppColors();

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ActivityIndicator color={colors.accent} />
    </View>
  );
};

const styles = StyleSheet.create({
  screen: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
  },
});
