import { randomUUID } from "expo-crypto";
import { useRouter } from "expo-router";
import { Pressable, StyleSheet, Text } from "react-native";
import { useTranslations } from "use-intl";

import { useAppColors } from "@/theme";

/**
 * Opens an empty thread under a new id. The server creates the thread with
 * its first message, so nothing is written until something is sent.
 */
export const NewChatButton = () => {
  const colors = useAppColors();
  const t = useTranslations("chat");
  const router = useRouter();

  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => {
        router.push({
          pathname: "/thread/[threadId]",
          params: { fresh: "1", threadId: randomUUID(), title: t("newChat") },
        });
      }}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: colors.accent, opacity: pressed ? 0.8 : 1 },
      ]}
    >
      <Text style={[styles.label, { color: colors.onAccent }]}>
        {t("newChat")}
      </Text>
    </Pressable>
  );
};

const styles = StyleSheet.create({
  button: {
    alignItems: "center",
    borderRadius: 12,
    paddingVertical: 12,
  },
  label: {
    fontSize: 16,
    fontWeight: "600",
  },
});
