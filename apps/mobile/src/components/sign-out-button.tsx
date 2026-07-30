import { Alert, Platform, Pressable, StyleSheet, Text } from "react-native";

import {
  authErrorMessage,
  toMobileAuthError,
} from "@/features/auth/auth-result";
import { useAuthSessionActions } from "@/features/auth/auth-session-boundary";
import { mobileMessage } from "@/i18n/messages";
import { authClient } from "@/lib/auth-client";
import { useAppColors } from "@/theme";

const MINIMUM_TOUCH_TARGET = 44;

export const SignOutButton = () => {
  const colors = useAppColors();
  const { refreshSession } = useAuthSessionActions();

  const signOut = async () => {
    const result = await authClient.signOut();
    if (result.error) {
      throw toMobileAuthError(result.error, mobileMessage("genericError"));
    }
    await refreshSession();
  };

  const runSignOut = () => {
    signOut().catch((error: unknown) => {
      Alert.alert(
        mobileMessage("genericError"),
        authErrorMessage(error, mobileMessage("tryAgain")),
      );
    });
  };

  const confirmSignOut = () => {
    if (Platform.OS === "web") {
      // React Native Web does not invoke Alert button callbacks.
      // eslint-disable-next-line no-alert -- browser confirmation is the web platform's native destructive-action dialog.
      if (globalThis.confirm(mobileMessage("signOut"))) {
        runSignOut();
      }
      return;
    }
    Alert.alert(mobileMessage("signOut"), undefined, [
      { style: "cancel", text: mobileMessage("cancel") },
      {
        onPress: runSignOut,
        style: "destructive",
        text: mobileMessage("signOut"),
      },
    ]);
  };

  return (
    <Pressable
      accessibilityLabel={mobileMessage("signOut")}
      accessibilityRole="button"
      onPress={confirmSignOut}
      style={({ pressed }) => [styles.button, { opacity: pressed ? 0.55 : 1 }]}
    >
      <Text style={[styles.label, { color: colors.accent }]}>
        {mobileMessage("signOut")}
      </Text>
    </Pressable>
  );
};

const styles = StyleSheet.create({
  button: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: MINIMUM_TOUCH_TARGET,
    minWidth: MINIMUM_TOUCH_TARGET,
    paddingHorizontal: 4,
    paddingVertical: 8,
  },
  label: {
    fontSize: 15,
    fontWeight: "600",
  },
});
