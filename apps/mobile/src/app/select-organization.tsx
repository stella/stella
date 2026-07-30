import { useState, type ReactNode } from "react";

import { useMutation } from "@tanstack/react-query";
import * as Crypto from "expo-crypto";
import { ActivityIndicator, StyleSheet, View } from "react-native";

import { ActionButton } from "@/components/action-button";
import { FormField } from "@/components/form-field";
import { FormScreen } from "@/components/form-screen";
import { InlineMessage } from "@/components/inline-message";
import {
  authErrorMessage,
  MobileAuthError,
  toMobileAuthError,
} from "@/features/auth/auth-result";
import { useAuthSessionActions } from "@/features/auth/auth-session-boundary";
import { mobileOrganizationSlug } from "@/features/auth/mobile-organization-slug";
import { mobileMessage } from "@/i18n/messages";
import { authClient } from "@/lib/auth-client";
import { useAppColors } from "@/theme";

export default function SelectOrganizationScreen() {
  const colors = useAppColors();
  const { refreshSession } = useAuthSessionActions();
  const organizations = authClient.useListOrganizations();
  const [organizationName, setOrganizationName] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const selectOrganization = useMutation({
    mutationFn: async (organizationId: string) => {
      const result = await authClient.organization.setActive({
        organizationId,
      });
      if (result.error) {
        throw toMobileAuthError(result.error, mobileMessage("genericError"));
      }
      await refreshSession();
    },
    onError: (error) => {
      setErrorMessage(authErrorMessage(error, mobileMessage("genericError")));
    },
    onSuccess: () => setErrorMessage(null),
  });

  const signOut = useMutation({
    mutationFn: async () => {
      const result = await authClient.signOut();
      if (result.error) {
        throw toMobileAuthError(result.error, mobileMessage("genericError"));
      }
      await refreshSession();
    },
    onError: (error) => {
      setErrorMessage(authErrorMessage(error, mobileMessage("genericError")));
    },
  });

  const createOrganization = useMutation({
    mutationFn: async () => {
      const name = organizationName.trim();
      if (name.length === 0) {
        throw new MobileAuthError({
          message: mobileMessage("createFirstOrganization"),
        });
      }
      const created = await authClient.organization.create({
        name,
        slug: mobileOrganizationSlug(
          name,
          Crypto.randomUUID().replaceAll("-", "").slice(0, 8),
        ),
      });
      if (created.error) {
        throw toMobileAuthError(created.error, mobileMessage("genericError"));
      }
      const selected = await authClient.organization.setActive({
        organizationId: created.data.id,
      });
      if (selected.error) {
        throw toMobileAuthError(selected.error, mobileMessage("genericError"));
      }
      await refreshSession();
    },
    onError: (error) => {
      setErrorMessage(authErrorMessage(error, mobileMessage("genericError")));
    },
    onSuccess: () => setErrorMessage(null),
  });

  const rows = organizations.data ?? [];
  let description = mobileMessage("chooseOrganization");
  let organizationContent: ReactNode;

  if (organizations.isPending) {
    description = mobileMessage("loading");
    organizationContent = (
      <ActivityIndicator accessibilityLabel={mobileMessage("loading")} />
    );
  } else if (organizations.error) {
    description = mobileMessage("genericError");
    organizationContent = (
      <>
        <InlineMessage message={mobileMessage("genericError")} />
        <ActionButton
          label={mobileMessage("retry")}
          onPress={() => {
            organizations.refetch().catch(() => undefined);
          }}
        />
      </>
    );
  } else if (rows.length === 0) {
    organizationContent = (
      <View style={styles.list}>
        <InlineMessage message={mobileMessage("createFirstOrganization")} />
        <FormField
          autoCapitalize="words"
          autoComplete="organization"
          label={mobileMessage("createFirstOrganization")}
          maxLength={80}
          onChangeText={(value) => {
            setOrganizationName(value);
            setErrorMessage(null);
          }}
          onSubmitEditing={() => createOrganization.mutate()}
          returnKeyType="done"
          value={organizationName}
        />
        <ActionButton
          disabled={
            organizationName.trim().length === 0 ||
            createOrganization.isPending ||
            signOut.isPending
          }
          label={mobileMessage("createFirstOrganization")}
          loading={createOrganization.isPending}
          onPress={() => createOrganization.mutate()}
        />
      </View>
    );
  } else {
    organizationContent = (
      <View style={styles.list}>
        {rows.map((organization) => (
          <ActionButton
            disabled={
              selectOrganization.isPending ||
              createOrganization.isPending ||
              signOut.isPending
            }
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
    );
  }

  return (
    <FormScreen description={description}>
      {organizationContent}
      {errorMessage ? <InlineMessage message={errorMessage} /> : null}
      {!organizations.isPending && !organizations.error && rows.length === 0 ? (
        <ActionButton
          label={mobileMessage("tryAgain")}
          onPress={() => {
            organizations.refetch().catch(() => undefined);
          }}
          variant="secondary"
        />
      ) : null}
      <View style={[styles.separator, { backgroundColor: colors.border }]} />
      <ActionButton
        disabled={selectOrganization.isPending || createOrganization.isPending}
        label={mobileMessage("signOut")}
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
