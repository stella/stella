import { useState } from "react";

import { useMutation } from "@tanstack/react-query";
import { StyleSheet, Switch, Text, View } from "react-native";

import { ActionButton } from "@/components/action-button";
import { FormField } from "@/components/form-field";
import { FormScreen } from "@/components/form-screen";
import {
  authErrorMessage,
  MobileAuthError,
  toMobileAuthError,
} from "@/features/auth/auth-result";
import { useAuthSessionActions } from "@/features/auth/auth-session-boundary";
import { authClient } from "@/lib/auth-client";
import { useAppColors } from "@/theme";

type TwoFactorMode = "totp" | "backupCode";

export default function TwoFactorScreen() {
  const colors = useAppColors();
  const { refreshSession } = useAuthSessionActions();
  const [mode, setMode] = useState<TwoFactorMode>("totp");
  const [code, setCode] = useState("");
  const [trustDevice, setTrustDevice] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const verify = useMutation({
    mutationFn: async () => {
      const normalizedCode = code.trim();
      if (normalizedCode.length === 0) {
        throw new MobileAuthError({ message: "Enter a verification code." });
      }
      const result =
        mode === "totp"
          ? await authClient.twoFactor.verifyTotp({
              code: normalizedCode,
              trustDevice,
            })
          : await authClient.twoFactor.verifyBackupCode({
              code: normalizedCode,
              trustDevice,
            });
      if (result.error) {
        throw toMobileAuthError(
          result.error,
          "The code could not be verified.",
        );
      }
      await refreshSession();
    },
    onError: (error) => {
      setCode("");
      setErrorMessage(
        authErrorMessage(error, "The code could not be verified."),
      );
    },
    onSuccess: () => setErrorMessage(null),
  });

  return (
    <FormScreen
      description={
        mode === "totp"
          ? "Enter the current code from your authenticator app."
          : "Enter one of your unused backup codes."
      }
    >
      <FormField
        autoComplete="one-time-code"
        autoFocus
        error={errorMessage}
        keyboardType={mode === "totp" ? "number-pad" : "default"}
        label={mode === "totp" ? "Authenticator code" : "Backup code"}
        maxLength={mode === "totp" ? 6 : undefined}
        onChangeText={(value) => {
          setCode(
            mode === "totp"
              ? value.replace(/\D/gu, "").slice(0, 6)
              : value.trim(),
          );
          setErrorMessage(null);
        }}
        onSubmitEditing={() => verify.mutate()}
        returnKeyType="done"
        secureTextEntry={mode === "backupCode"}
        style={mode === "totp" ? styles.totp : undefined}
        textContentType="oneTimeCode"
        value={code}
      />
      <View style={styles.trustRow}>
        <Text style={[styles.trustLabel, { color: colors.text }]}>
          Trust this device
        </Text>
        <Switch
          accessibilityLabel="Trust this device"
          disabled={verify.isPending}
          onValueChange={setTrustDevice}
          value={trustDevice}
        />
      </View>
      <ActionButton
        disabled={code.trim().length === 0}
        label="Verify"
        loading={verify.isPending}
        onPress={() => verify.mutate()}
      />
      <ActionButton
        disabled={verify.isPending}
        label={mode === "totp" ? "Use a backup code" : "Use authenticator app"}
        onPress={() => {
          setMode(mode === "totp" ? "backupCode" : "totp");
          setCode("");
          setErrorMessage(null);
        }}
        variant="secondary"
      />
    </FormScreen>
  );
}

const styles = StyleSheet.create({
  totp: {
    fontSize: 26,
    fontVariant: ["tabular-nums"],
    letterSpacing: 8,
    textAlign: "center",
  },
  trustLabel: {
    fontSize: 16,
  },
  trustRow: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
});
