import { useState } from "react";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { ActionButton } from "@/components/action-button";
import { FormField } from "@/components/form-field";
import { FormScreen } from "@/components/form-screen";
import { InlineMessage } from "@/components/inline-message";
import { parseSignInEmail } from "@/features/auth/auth-input";
import {
  authErrorMessage,
  isTwoFactorRedirect,
  MobileAuthError,
  toMobileAuthError,
} from "@/features/auth/auth-result";
import { useAuthSessionActions } from "@/features/auth/auth-session-boundary";
import { api } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { useAppColors } from "@/theme";

type SocialProvider = "google" | "microsoft";

const authCapabilitiesQuery = {
  queryKey: ["auth-capabilities"] as const,
  queryFn: async ({ signal }: { signal: AbortSignal }) => {
    const response = await api.auth.capabilities.get({ fetch: { signal } });
    if (response.error) {
      throw new MobileAuthError({
        message: "stella sign-in methods are unavailable.",
      });
    }
    return response.data;
  },
};

export default function SignInScreen() {
  const colors = useAppColors();
  const router = useRouter();
  const { refreshSession } = useAuthSessionActions();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordEmailError, setPasswordEmailError] = useState<string | null>(
    null,
  );
  const [otpEmailError, setOtpEmailError] = useState<string | null>(null);
  const capabilities = useQuery(authCapabilitiesQuery);

  const socialSignIn = useMutation({
    mutationFn: async (provider: SocialProvider) => {
      const result = await authClient.signIn.social({
        callbackURL: "/",
        errorCallbackURL: "/sign-in",
        provider,
      });
      if (result.error) {
        throw toMobileAuthError(result.error, "Social sign-in failed.");
      }
      if (isTwoFactorRedirect(result.data)) {
        return "twoFactor" as const;
      }
      await refreshSession();
      return "complete" as const;
    },
    onSuccess: (result) => {
      if (result === "twoFactor") {
        router.push("/two-factor");
      }
    },
  });

  const passwordSignIn = useMutation({
    mutationFn: async () => {
      const normalizedEmail = parseSignInEmail(email);
      const result = await authClient.signIn.email({
        callbackURL: "/",
        email: normalizedEmail,
        password,
      });
      if (result.error) {
        throw toMobileAuthError(result.error, "Password sign-in failed.");
      }
      if (isTwoFactorRedirect(result.data)) {
        return "twoFactor" as const;
      }
      await refreshSession();
      return "complete" as const;
    },
    onError: (error) => {
      setPasswordEmailError(authErrorMessage(error, "Sign-in failed."));
    },
    onSuccess: (result) => {
      setPasswordEmailError(null);
      if (result === "twoFactor") {
        router.push("/two-factor");
      }
    },
  });

  const sendEmailOtp = useMutation({
    mutationFn: async () => {
      const normalizedEmail = parseSignInEmail(email);
      const result = await authClient.emailOtp.sendVerificationOtp({
        email: normalizedEmail,
        type: "sign-in",
      });
      if (result.error) {
        throw toMobileAuthError(
          result.error,
          "The sign-in code could not be sent.",
        );
      }
      return normalizedEmail;
    },
    onError: (error) => {
      setOtpEmailError(
        authErrorMessage(error, "Could not send the sign-in code."),
      );
    },
    onSuccess: (normalizedEmail) => {
      setOtpEmailError(null);
      router.push({ pathname: "/otp", params: { email: normalizedEmail } });
    },
  });

  if (capabilities.isPending) {
    return (
      <FormScreen description="Loading the sign-in methods enabled for this stella deployment…">
        <ActivityIndicator accessibilityLabel="Connecting" />
      </FormScreen>
    );
  }

  if (capabilities.error) {
    return (
      <FormScreen description="stella could not load the available sign-in methods.">
        <InlineMessage message="Check your connection and try again." />
        <ActionButton
          label="Retry"
          onPress={() => {
            capabilities.refetch().catch(() => undefined);
          }}
        />
      </FormScreen>
    );
  }

  const methods = capabilities.data;
  const mutationError = socialSignIn.error
    ? authErrorMessage(socialSignIn.error, "Social sign-in failed.")
    : null;
  const anyMutationPending =
    socialSignIn.isPending ||
    passwordSignIn.isPending ||
    sendEmailOtp.isPending;

  return (
    <FormScreen description="Use the same account you use on the web. Your session is stored in the device's secure storage.">
      {methods.social.google ? (
        <ActionButton
          disabled={anyMutationPending}
          label="Continue with Google"
          loading={
            socialSignIn.isPending && socialSignIn.variables === "google"
          }
          onPress={() => socialSignIn.mutate("google")}
          variant="secondary"
        />
      ) : null}
      {methods.social.microsoft ? (
        <ActionButton
          disabled={anyMutationPending}
          label="Continue with Microsoft"
          loading={
            socialSignIn.isPending && socialSignIn.variables === "microsoft"
          }
          onPress={() => socialSignIn.mutate("microsoft")}
          variant="secondary"
        />
      ) : null}

      {methods.localPassword && !methods.bootstrap ? (
        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { color: colors.muted }]}>
            Password
          </Text>
          <FormField
            autoCapitalize="none"
            autoComplete="email"
            error={passwordEmailError}
            keyboardType="email-address"
            label="Email"
            onChangeText={(value) => {
              setEmail(value);
              setPasswordEmailError(null);
              setOtpEmailError(null);
            }}
            returnKeyType="next"
            textContentType="emailAddress"
            value={email}
          />
          <FormField
            autoComplete="current-password"
            label="Password"
            onChangeText={setPassword}
            onSubmitEditing={() => passwordSignIn.mutate()}
            returnKeyType="go"
            secureTextEntry
            textContentType="password"
            value={password}
          />
          <ActionButton
            disabled={anyMutationPending || password.length === 0}
            label="Sign in with password"
            loading={passwordSignIn.isPending}
            onPress={() => passwordSignIn.mutate()}
          />
        </View>
      ) : null}

      {methods.emailOtp ? (
        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { color: colors.muted }]}>
            Email code
          </Text>
          <FormField
            autoCapitalize="none"
            autoComplete="email"
            error={otpEmailError}
            keyboardType="email-address"
            label="Email"
            onChangeText={(value) => {
              setEmail(value);
              setPasswordEmailError(null);
              setOtpEmailError(null);
            }}
            onSubmitEditing={() => sendEmailOtp.mutate()}
            returnKeyType="send"
            textContentType="emailAddress"
            value={email}
          />
          <ActionButton
            disabled={anyMutationPending}
            label="Email me a sign-in code"
            loading={sendEmailOtp.isPending}
            onPress={() => sendEmailOtp.mutate()}
          />
        </View>
      ) : null}

      {methods.bootstrap ? (
        <InlineMessage message="Create the first self-hosted account in the web app, then return here to sign in." />
      ) : null}
      {mutationError ? <InlineMessage message={mutationError} /> : null}
    </FormScreen>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: 12,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: "600",
    textTransform: "uppercase",
  },
});
