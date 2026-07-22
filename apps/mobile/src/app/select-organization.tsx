import { useState } from "react";

import { useMutation } from "@tanstack/react-query";
import { ActivityIndicator, StyleSheet, View } from "react-native";

import { ActionButton } from "@/components/action-button";
import { FormScreen } from "@/components/form-screen";
import { InlineMessage } from "@/components/inline-message";
import {
  authErrorMessage,
  toMobileAuthError,
} from "@/features/auth/auth-result";
import { useAuthSessionActions } from "@/features/auth/auth-session-boundary";
import { authClient } from "@/lib/auth-client";
import { useAppColors } from "@/theme";

export default function SelectOrganizationScreen() {
  const colors = useAppColors();
  const { refreshSession } = useAuthSessionActions();
  const organizations = authClient.useListOrganizations();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const selectOrganization = useMutation({
    mutationFn: async (organizationId: string) => {
      const result = await authClient.organization.setActive({
        organizationId,
      });
      if (result.error) {
        throw toMobileAuthError(
          result.error,
          "The organization could not be selected.",
        );
      }
      await refreshSession();
    },
    onError: (error) => {
      setErrorMessage(
        authErrorMessage(error, "The organization could not be selected."),
      );
    },
    onSuccess: () => setErrorMessage(null),
  });

  const signOut = useMutation({
    mutationFn: async () => {
      const result = await authClient.signOut();
      if (result.error) {
        throw toMobileAuthError(result.error, "Sign-out failed.");
      }
      await refreshSession();
    },
    onError: (error) => {
      setErrorMessage(authErrorMessage(error, "Sign-out failed."));
    },
  });

  if (organizations.isPending) {
    return (
      <FormScreen description="Loading the organizations available to your account…">
        <ActivityIndicator accessibilityLabel="Connecting" />
      </FormScreen>
    );
  }

  if (organizations.error) {
    return (
      <FormScreen description="stella could not load your organizations.">
        <InlineMessage message="Check your connection and try again." />
        <ActionButton
          label="Retry"
          onPress={() => {
            organizations.refetch().catch(() => undefined);
          }}
        />
      </FormScreen>
    );
  }

  const rows = organizations.data ?? [];

  return (
    <FormScreen description="Select the organization whose chats, tasks, and matters you want to open.">
      {rows.length === 0 ? (
        <InlineMessage message="This account has no organization yet. Complete onboarding in the stella web app, then retry here." />
      ) : (
        <View style={styles.list}>
          {rows.map((organization) => (
            <ActionButton
              disabled={selectOrganization.isPending || signOut.isPending}
              key={organization.id}
              label={organization.name}
              loading={
                selectOrganization.isPending &&
                selectOrganization.variables === organization.id
              }
              onPress={() => selectOrganization.mutate(organization.id)}
              variant="secondary"
            />
          ))}
        </View>
      )}
      {errorMessage ? <InlineMessage message={errorMessage} /> : null}
      {rows.length === 0 ? (
        <ActionButton
          label="Check again"
          onPress={() => {
            organizations.refetch().catch(() => undefined);
          }}
          variant="secondary"
        />
      ) : null}
      <View style={[styles.separator, { backgroundColor: colors.border }]} />
      <ActionButton
        disabled={selectOrganization.isPending}
        label="Sign out"
        loading={signOut.isPending}
        onPress={() => signOut.mutate()}
        variant="danger"
      />
    </FormScreen>
  );
}

const styles = StyleSheet.create({
  list: {
    gap: 10,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
  },
});
