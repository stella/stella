import { createContext, use, useMemo } from "react";

import { Stack } from "expo-router";
import { ActivityIndicator } from "react-native";

import { ActionButton } from "@/components/action-button";
import { FormScreen } from "@/components/form-screen";
import { InlineMessage } from "@/components/inline-message";
import { authClient } from "@/lib/auth-client";

import { MobileAuthError } from "./auth-result";
import { resolveAuthSessionState } from "./auth-session-state";

type AuthSessionActions = {
  refreshSession: () => Promise<void>;
};

const AuthSessionActionsContext = createContext<AuthSessionActions | null>(
  null,
);

export const useAuthSessionActions = () => {
  const value = use(AuthSessionActionsContext);
  if (value === null) {
    throw new MobileAuthError({
      message: "Auth session actions are unavailable outside the boundary.",
    });
  }
  return value;
};

export const AuthSessionBoundary = () => {
  const session = authClient.useSession();
  const state = resolveAuthSessionState({
    error: session.error,
    isPending: session.isPending,
    session: session.data,
  });
  const actions = useMemo<AuthSessionActions>(
    () => ({ refreshSession: session.refetch }),
    [session.refetch],
  );

  if (state === "loading") {
    return (
      <FormScreen description="Restoring your secure stella session…">
        <ActivityIndicator accessibilityLabel="Connecting" />
      </FormScreen>
    );
  }

  if (state === "unavailable") {
    return (
      <FormScreen description="stella could not verify your session. Your signed-in state has not been changed.">
        <InlineMessage message="Check your connection and try again." />
        <ActionButton
          label="Retry"
          onPress={() => {
            session.refetch().catch(() => undefined);
          }}
        />
      </FormScreen>
    );
  }

  return (
    <AuthSessionActionsContext value={actions}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Protected guard={state === "signedOut"}>
          <Stack.Screen name="(auth)" />
        </Stack.Protected>
        <Stack.Protected guard={state === "organizationRequired"}>
          <Stack.Screen
            name="select-organization"
            options={{
              headerLargeTitle: false,
              headerShadowVisible: false,
              headerShown: true,
              headerTransparent: true,
              title: "Choose organization",
            }}
          />
        </Stack.Protected>
        <Stack.Protected guard={state === "ready"}>
          <Stack.Screen name="(tabs)" />
        </Stack.Protected>
      </Stack>
    </AuthSessionActionsContext>
  );
};
