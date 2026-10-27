import { useState } from "react";

import { Pressable, View } from "react-native";
import { useTranslations } from "use-intl";

import { Text, TextInput } from "@/components/ui/text";
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
    <View className="bg-background px-3 pt-1 pb-2">
      <View className="border-input bg-card flex-row items-end gap-2 rounded-3xl border py-1.5 pr-1.5 pl-3.5">
        <TextInput
          accessibilityLabel={t("composerPlaceholder")}
          className="max-h-33 flex-1"
          multiline
          onChangeText={setDraft}
          placeholder={t("composerPlaceholder")}
          value={draft}
          variant="bare"
        />
        {busy ? (
          <Pressable
            accessibilityLabel={t("stop")}
            accessibilityRole="button"
            accessibilityState={{ disabled: !canStop }}
            className={`size-9 items-center justify-center rounded-full ${canStop ? "bg-primary" : "bg-secondary"}`}
            disabled={!canStop}
            onPress={onStop}
          >
            <View
              className="size-3 rounded-sm"
              style={{ backgroundColor: colors.onAccent }}
            />
          </Pressable>
        ) : (
          <Pressable
            accessibilityLabel={t("send")}
            accessibilityRole="button"
            accessibilityState={{ disabled: message === "" }}
            className={`size-9 items-center justify-center rounded-full ${message === "" ? "bg-secondary" : "bg-primary"}`}
            disabled={message === ""}
            onPress={send}
          >
            <Text
              style={{ color: message === "" ? colors.muted : colors.onAccent }}
              variant="headline"
            >
              ↑
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  );
};
