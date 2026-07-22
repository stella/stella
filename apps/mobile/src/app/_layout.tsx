/* oxlint-disable react/style-prop-object -- Expo StatusBar uses `style` as an appearance enum, not a React Native style object. */
import { QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { AuthSessionBoundary } from "@/features/auth/auth-session-boundary";
import { queryClient } from "@/lib/query-client";
import { useAppNavigationTheme } from "@/theme";

export default function RootLayout() {
  const navigationTheme = useAppNavigationTheme();

  return (
    <SafeAreaProvider>
      <ThemeProvider value={navigationTheme}>
        <QueryClientProvider client={queryClient}>
          <AuthSessionBoundary />
          <StatusBar style="auto" />
        </QueryClientProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
