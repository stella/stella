import { View } from "react-native";

import { Loader } from "@stll/ui/loader";

/** A full screen with one spinner, while something the screen needs loads. */
export const LoadingScreen = () => (
  <View className="bg-background flex-1 items-center justify-center">
    <Loader />
  </View>
);
