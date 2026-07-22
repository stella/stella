import { useState } from "react";

import { useMutation } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StyleSheet, Text } from "react-native";

import { ActionButton } from "@/components/action-button";
import { FormField } from "@/components/form-field";
import { FormScreen } from "@/components/form-screen";
import { InlineMessage } from "@/components/inline-message";
import { parseEmailOtp, parseSignInEmail } from "@/features/auth/auth-input";
import {
  authErrorMessage,
  isTwoFactorRedirect,
  toMobileAuthError,
} from "@/features/auth/auth-result";
import { useAuthSessionActions } from "@/features/auth/auth-session-boundary";
import { authClient } from "@/lib/auth-client";
import { useAppColors } from "@/theme";

export default function EmailOtpScreen() {
  const colors = useAppColors();
  const router = useRouter();
  const params = useLocalSearchParams<{ email?: string | string[] }>();
  const { refreshSession } = useAuthSessionActions();
  const emailParam = Array.isArray(params.email)
    ? params.email[0]
    : params.email;
  const [code, setCode] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const verifyOtp = useMutation({
    mutationFn: async () => {
      const email = parseSignInEmail(emailParam);
      const otp = parseEmailOtp(code);
      const result = await authClient.signIn.emailOtp({ email, otp });
      if (result.error) {
        throw toMobileAuthError(
          result.error,
          "The code could not be verified.",
        );
      }
      if (isTwoFactorRedirect(result.data)) {
        return "twoFactor" as const;
      }
      await refreshSession();
      return "complete" as const;
    },
    onError: (error) => {
      setCode("");
      setErrorMessage(
        authErrorMessage(error, "The code could not be verified."),
      );
    },
    onSuccess: (result) => {
      setErrorMessage(null);
      if (result === "twoFactor") {
        router.replace("/two-factor");
      }
    },
  });

  const resendOtp = useMutation({
    mutationFn: async () => {
      const email = parseSignInEmail(emailParam);
      const result = await authClient.emailOtp.sendVerificationOtp({
        email,
        type: "sign-in",
      });
      if (result.error) {
        throw toMobileAuthError(result.error, "A new code could not be sent.");
      }
    },
    onError: (error) => {
      setErrorMessage(authErrorMessage(error, "A new code could not be sent."));
    },
    onSuccess: () => setErrorMessage(null),
  });

  if (!emailParam) {
    return (
      <FormScreen description="This verification link is missing its email address.">
        <InlineMessage message="Return to sign in and request a new code." />
        <ActionButton
          label="Back to sign in"
          onPress={() => router.replace("/sign-in")}
        />
      </FormScreen>
    );
  }

  return (
    <FormScreen description={`Enter the six-digit code sent to ${emailParam}.`}>
      <FormField
        autoComplete="one-time-code"
        error={errorMessage}
        keyboardType="number-pad"
        label="Verification code"
        maxLength={6}
        onChangeText={(value) => {
          setCode(value.replace(/\D/gu, "").slice(0, 6));
          setErrorMessage(null);
        }}
        onSubmitEditing={() => verifyOtp.mutate()}
        returnKeyType="done"
        style={styles.code}
        textContentType="oneTimeCode"
        value={code}
      />
      <ActionButton
        disabled={code.length !== 6 || resendOtp.isPending}
        label="Verify"
        loading={verifyOtp.isPending}
        onPress={() => verifyOtp.mutate()}
      />
      <ActionButton
        disabled={verifyOtp.isPending}
        label="Send a new code"
        loading={resendOtp.isPending}
        onPress={() => resendOtp.mutate()}
        variant="secondary"
      />
      <Text selectable style={[styles.hint, { color: colors.muted }]}>
        Codes expire and can only be used once.
      </Text>
    </FormScreen>
  );
}

const styles = StyleSheet.create({
  code: {
    fontSize: 26,
    fontVariant: ["tabular-nums"],
    letterSpacing: 8,
    textAlign: "center",
  },
  hint: {
    fontSize: 13,
    lineHeight: 18,
    textAlign: "center",
  },
});
