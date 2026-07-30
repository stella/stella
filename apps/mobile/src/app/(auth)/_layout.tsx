import { Stack } from "expo-router/stack";

import { mobileMessage } from "@/i18n/messages";

export const unstable_settings = { anchor: "sign-in" };

export default function AuthLayout() {
  return (
    <Stack
      screenOptions={{
        headerBackButtonDisplayMode: "minimal",
        headerLargeTitle: false,
        headerShadowVisible: false,
        headerTransparent: true,
      }}
    >
      <Stack.Screen
        name="sign-in"
        options={{ title: mobileMessage("signIn") }}
      />
      <Stack.Screen name="otp" options={{ title: mobileMessage("verify") }} />
      <Stack.Screen
        name="two-factor"
        options={{ title: mobileMessage("twoFactorTitle") }}
      />
    </Stack>
  );
}
