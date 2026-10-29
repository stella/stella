import { useState } from "react";

import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useTranslations } from "use-intl";

import { useAppColors } from "@/theme";

/**
 * The message box under a thread. It grows with what is typed up to a few
 * lines, then scrolls. While an answer is arriving its button stops the
 * answer instead of sending; it can stop once the server has named the turn.
 */
export const ChatComposer = ({
  busy,
  canStop,
  onSend,
  onStop,
}: {
  busy: boolean;
  canStop: boolean;
  /** Sends the text; returns false when it was not taken, so it stays in the box. */
  onSend: (text: string, onRefused: () => void) => boolean;
  onStop: () => void;
}) => {
  const colors = useAppColors();
  const t = useTranslations("chat");
  const [draft, setDraft] = useState("");
  const message = draft.trim();

  const send = () => {
    if (message === "") {
      return;
    }
    const taken = onSend(message, () => {
      // Handed back only into an empty box, so nothing typed since is lost.
      setDraft((typed) => (typed === "" ? message : typed));
    });
    if (taken) {
      setDraft("");
    }
  };

  return (
    <View
      style={[
        styles.bar,
        { backgroundColor: colors.card, borderTopColor: colors.border },
      ]}
    >
      <TextInput
        accessibilityLabel={t("composerPlaceholder")}
        multiline
        onChangeText={setDraft}
        placeholder={t("composerPlaceholder")}
        placeholderTextColor={colors.muted}
        style={[
          styles.input,
          {
            backgroundColor: colors.background,
            borderColor: colors.border,
            color: colors.text,
          },
        ]}
        value={draft}
      />
      {busy ? (
        <Pressable
          accessibilityLabel={t("stop")}
          accessibilityRole="button"
          accessibilityState={{ disabled: !canStop }}
          disabled={!canStop}
          onPress={onStop}
          style={[
            styles.button,
            { backgroundColor: canStop ? colors.text : colors.border },
          ]}
        >
          <View style={[styles.stopMark, { backgroundColor: colors.card }]} />
        </Pressable>
      ) : (
        <Pressable
          accessibilityLabel={t("send")}
          accessibilityRole="button"
          accessibilityState={{ disabled: message === "" }}
          disabled={message === ""}
          onPress={send}
          style={[
            styles.button,
            {
              backgroundColor: message === "" ? colors.border : colors.accent,
            },
          ]}
        >
          <Text style={[styles.sendMark, { color: colors.onAccent }]}>↑</Text>
        </Pressable>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  bar: {
    alignItems: "flex-end",
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  button: {
    alignItems: "center",
    borderRadius: 18,
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  input: {
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    fontSize: 16,
    lineHeight: 21,
    maxHeight: 132,
    minHeight: 36,
    paddingBottom: 8,
    paddingHorizontal: 14,
    paddingTop: 8,
  },
  sendMark: {
    fontSize: 20,
    fontWeight: "700",
    lineHeight: 22,
  },
  stopMark: {
    borderRadius: 2,
    height: 12,
    width: 12,
  },
});
