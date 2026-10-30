import { ActivityIndicator, View } from "react-native";

import { useAppColors } from "@/theme";

/** A full screen with one spinner, while something the screen needs loads. */
export const LoadingScreen = () => {
  const colors = useAppColors();

  return (
    <View className="bg-background flex-1 items-center justify-center">
      <ActivityIndicator color={colors.muted} />
    </View>
  );
};
