import { Stack } from "expo-router";

import { useSession } from "@/connection/session-provider";

/** Signed out, only sign-in exists; signed in, only the app does. */
export const ProtectedScreens = () => {
  const { state } = useSession();
  const signedIn = state.status === "signed-in";

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={signedIn}>
        <Stack.Screen name="(tabs)" />
      </Stack.Protected>
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="sign-in" />
      </Stack.Protected>
    </Stack>
  );
};
