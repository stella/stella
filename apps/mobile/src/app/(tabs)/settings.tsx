import { useState, useTransition } from "react";

import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTranslations } from "use-intl";

import { ScreenHeading, screenStyles } from "@/components/empty-state-screen";
import { useSession } from "@/connection/session-provider";
import { useAppColors } from "@/theme";

const SettingsScreen = () => {
  const t = useTranslations();
  const colors = useAppColors();
  const { signOut, state } = useSession();
  const [pending, startTransition] = useTransition();
  const [signOutFailed, setSignOutFailed] = useState(false);
  const serverUrl =
    state.status === "signed-in"
      ? (state.source.session()?.serverUrl ?? null)
      : null;

  return (
    <SafeAreaView
      edges={["top"]}
      style={[screenStyles.screen, { backgroundColor: colors.background }]}
    >
      <ScrollView contentContainerStyle={screenStyles.content}>
        <ScreenHeading title={t("tabs.settings")} />
        <Text
          accessibilityRole="header"
          style={[styles.section, { color: colors.muted }]}
        >
          {t("settings.accountTitle")}
        </Text>
        <View
          style={[
            styles.card,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          <Text style={[styles.label, { color: colors.muted }]}>
            {t("settings.server")}
          </Text>
          <Text selectable style={[styles.value, { color: colors.text }]}>
            {serverUrl}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ busy: pending, disabled: pending }}
          disabled={pending}
          onPress={() => {
            startTransition(async () => {
              const result = await signOut();
              setSignOutFailed(result.isErr());
            });
          }}
          style={({ pressed }) => [
            styles.button,
            {
              borderColor: colors.border,
              opacity: pressed || pending ? 0.7 : 1,
            },
          ]}
        >
          {pending ? (
            <ActivityIndicator color={colors.text} />
          ) : (
            <Text style={[styles.buttonLabel, { color: colors.text }]}>
              {t("settings.signOut")}
            </Text>
          )}
        </Pressable>
        {signOutFailed ? (
          <Text style={[styles.error, { color: colors.muted }]}>
            {t("settings.signOutFailed")}
          </Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
};

export default SettingsScreen;

const styles = StyleSheet.create({
  error: {
    fontSize: 14,
  },
  button: {
    alignItems: "center",
    borderRadius: 14,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 50,
  },
  buttonLabel: {
    fontSize: 17,
    fontWeight: "600",
  },
  card: {
    borderRadius: 16,
    borderWidth: 1,
    gap: 4,
    padding: 16,
  },
  label: {
    fontSize: 13,
    fontWeight: "600",
  },
  section: {
    fontSize: 13,
    fontWeight: "600",
    marginBottom: -12,
    textTransform: "uppercase",
  },
  value: {
    fontSize: 16,
  },
});
