/* oxlint-disable react/style-prop-object -- Expo StatusBar uses `style` as an appearance enum, not a React Native style object. */
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";

const RootLayout = () => (
  <SafeAreaProvider>
    <Stack screenOptions={{ headerShown: false }} />
    <StatusBar style="auto" />
  </SafeAreaProvider>
);

export default RootLayout;
