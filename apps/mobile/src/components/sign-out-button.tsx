import { Alert, Pressable, StyleSheet, Text } from "react-native";

import {
  authErrorMessage,
  toMobileAuthError,
} from "@/features/auth/auth-result";
import { useAuthSessionActions } from "@/features/auth/auth-session-boundary";
import { authClient } from "@/lib/auth-client";
import { useAppColors } from "@/theme";

export const SignOutButton = () => {
  const colors = useAppColors();
  const { refreshSession } = useAuthSessionActions();

  const signOut = async () => {
    const result = await authClient.signOut();
    if (result.error) {
      throw toMobileAuthError(result.error, "Sign-out failed.");
    }
    await refreshSession();
  };

  return (
    <Pressable
      accessibilityLabel="Sign out"
      accessibilityRole="button"
      onPress={() => {
        Alert.alert(
          "Sign out?",
          "Your secure session will be removed from this device.",
          [
            { style: "cancel", text: "Cancel" },
            {
              onPress: () => {
                signOut().catch((error: unknown) => {
                  Alert.alert(
                    "Sign-out failed",
                    authErrorMessage(error, "Please try again."),
                  );
                });
              },
              style: "destructive",
              text: "Sign out",
            },
          ],
        );
      }}
      style={({ pressed }) => [styles.button, { opacity: pressed ? 0.55 : 1 }]}
    >
      <Text style={[styles.label, { color: colors.accent }]}>Sign out</Text>
    </Pressable>
  );
};

const styles = StyleSheet.create({
  button: {
    paddingHorizontal: 4,
    paddingVertical: 8,
  },
  label: {
    fontSize: 15,
    fontWeight: "600",
  },
});
