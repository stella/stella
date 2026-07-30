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
import {
  signInSocialOnMobile,
  type MobileSocialProvider,
} from "@/features/auth/mobile-social-auth";
import { mobileMessage } from "@/i18n/messages";
import { api } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { useAppColors } from "@/theme";

const authCapabilitiesQuery = {
  queryKey: ["auth-capabilities"] as const,
  queryFn: async ({ signal }: { signal: AbortSignal }) => {
    const response = await api.auth.capabilities.get({ fetch: { signal } });
    if (response.error) {
      throw new MobileAuthError({
        message: mobileMessage("genericError"),
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
    mutationFn: async (provider: MobileSocialProvider) => {
      const result = await signInSocialOnMobile(provider);
      if (result === "complete") {
        await refreshSession();
      }
      return result;
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
        throw toMobileAuthError(result.error, mobileMessage("genericError"));
      }
      if (isTwoFactorRedirect(result.data)) {
        return "twoFactor" as const;
      }
      await refreshSession();
      return "complete" as const;
    },
    onError: (error) => {
      setPasswordEmailError(
        authErrorMessage(error, mobileMessage("genericError")),
      );
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
        throw toMobileAuthError(result.error, mobileMessage("genericError"));
      }
      return normalizedEmail;
    },
    onError: (error) => {
      setOtpEmailError(authErrorMessage(error, mobileMessage("genericError")));
    },
    onSuccess: (normalizedEmail) => {
      setOtpEmailError(null);
      router.push({ pathname: "/otp", params: { email: normalizedEmail } });
    },
  });

  if (capabilities.isPending) {
    return (
      <FormScreen description={mobileMessage("loading")}>
        <ActivityIndicator accessibilityLabel={mobileMessage("loading")} />
      </FormScreen>
    );
  }

  if (capabilities.error) {
    return (
      <FormScreen description={mobileMessage("genericError")}>
        <InlineMessage message={mobileMessage("genericError")} />
        <ActionButton
          label={mobileMessage("retry")}
          onPress={() => {
            capabilities.refetch().catch(() => undefined);
          }}
        />
      </FormScreen>
    );
  }

  const methods = capabilities.data;
  const mutationError = socialSignIn.error
    ? authErrorMessage(socialSignIn.error, mobileMessage("genericError"))
    : null;
  const anyMutationPending =
    socialSignIn.isPending ||
    passwordSignIn.isPending ||
    sendEmailOtp.isPending;

  return (
    <FormScreen description={mobileMessage("authDescription")}>
      {methods.social.google ? (
        <ActionButton
          disabled={anyMutationPending}
          label={mobileMessage("continueGoogle")}
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
          label={mobileMessage("continueMicrosoft")}
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
            {mobileMessage("password")}
          </Text>
          <FormField
            autoCapitalize="none"
            autoComplete="email"
            error={passwordEmailError}
            keyboardType="email-address"
            label={mobileMessage("email")}
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
            label={mobileMessage("password")}
            onChangeText={setPassword}
            onSubmitEditing={() => passwordSignIn.mutate()}
            returnKeyType="go"
            secureTextEntry
            textContentType="password"
            value={password}
          />
          <ActionButton
            disabled={anyMutationPending || password.length === 0}
            label={mobileMessage("signInWithPassword")}
            loading={passwordSignIn.isPending}
            onPress={() => passwordSignIn.mutate()}
          />
        </View>
      ) : null}

      {methods.emailOtp ? (
        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { color: colors.muted }]}>
            {mobileMessage("email")}
          </Text>
          <FormField
            autoCapitalize="none"
            autoComplete="email"
            error={otpEmailError}
            keyboardType="email-address"
            label={mobileMessage("email")}
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
            label={mobileMessage("continueWithEmail")}
            loading={sendEmailOtp.isPending}
            onPress={() => sendEmailOtp.mutate()}
          />
        </View>
      ) : null}

      {methods.bootstrap ? (
        <InlineMessage message={mobileMessage("createFirstAccount")} />
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
