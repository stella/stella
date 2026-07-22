import { createContext, use, useEffect, useMemo, useRef } from "react";

import { useQueryClient } from "@tanstack/react-query";
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
const ActiveOrganizationIdContext = createContext<string | null>(null);

export const useAuthSessionActions = () => {
  const value = use(AuthSessionActionsContext);
  if (value === null) {
    throw new MobileAuthError({
      message: "Auth session actions are unavailable outside the boundary.",
    });
  }
  return value;
};

export const useActiveOrganizationId = () => {
  const value = use(ActiveOrganizationIdContext);
  if (value === null) {
    throw new MobileAuthError({
      message: "An active organization is required for this route.",
    });
  }
  return value;
};

export const AuthSessionBoundary = () => {
  const queryClient = useQueryClient();
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
  const activeOrganizationId =
    state.type === "ready" ? state.activeOrganizationId : null;
  const previousActiveOrganizationId = useRef<string | null>(null);

  useEffect(() => {
    const previous = previousActiveOrganizationId.current;
    if (previous !== null && previous !== activeOrganizationId) {
      queryClient.clear();
    }
    previousActiveOrganizationId.current = activeOrganizationId;
  }, [activeOrganizationId, queryClient]);

  if (state.type === "loading") {
    return (
      <FormScreen description="Restoring your secure stella session…">
        <ActivityIndicator accessibilityLabel="Connecting" />
      </FormScreen>
    );
  }

  if (state.type === "unavailable") {
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
      <ActiveOrganizationIdContext value={activeOrganizationId}>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Protected guard={state.type === "signedOut"}>
            <Stack.Screen name="(auth)" />
          </Stack.Protected>
          <Stack.Protected guard={state.type === "organizationRequired"}>
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
          <Stack.Protected guard={state.type === "ready"}>
            <Stack.Screen name="(tabs)" />
          </Stack.Protected>
        </Stack>
      </ActiveOrganizationIdContext>
    </AuthSessionActionsContext>
  );
};
