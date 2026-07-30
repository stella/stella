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
import { mobileMessage, mobileMessageWithEmail } from "@/i18n/messages";
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
        throw toMobileAuthError(result.error, mobileMessage("invalidCode"));
      }
      if (isTwoFactorRedirect(result.data)) {
        return "twoFactor" as const;
      }
      await refreshSession();
      return "complete" as const;
    },
    onError: (error) => {
      setCode("");
      setErrorMessage(authErrorMessage(error, mobileMessage("invalidCode")));
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
        throw toMobileAuthError(result.error, mobileMessage("genericError"));
      }
    },
    onError: (error) => {
      setErrorMessage(authErrorMessage(error, mobileMessage("genericError")));
    },
    onSuccess: () => setErrorMessage(null),
  });

  if (!emailParam) {
    return (
      <FormScreen description={mobileMessage("genericError")}>
        <InlineMessage message={mobileMessage("genericError")} />
        <ActionButton
          label={mobileMessage("signIn")}
          onPress={() => router.replace("/sign-in")}
        />
      </FormScreen>
    );
  }

  return (
    <FormScreen description={mobileMessageWithEmail("codeSentTo", emailParam)}>
      <FormField
        autoComplete="one-time-code"
        error={errorMessage}
        keyboardType="number-pad"
        label={mobileMessage("verify")}
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
        label={mobileMessage("verify")}
        loading={verifyOtp.isPending}
        onPress={() => verifyOtp.mutate()}
      />
      <ActionButton
        disabled={verifyOtp.isPending}
        label={mobileMessage("tryAgain")}
        loading={resendOtp.isPending}
        onPress={() => resendOtp.mutate()}
        variant="secondary"
      />
      <Text selectable style={[styles.hint, { color: colors.muted }]}>
        {mobileMessage("checkSpamHint")}
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
