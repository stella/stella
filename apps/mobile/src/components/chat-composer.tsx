import { useState } from "react";

import { Pressable, View } from "react-native";
import { useTranslations } from "use-intl";

import { COMPOSER_BOX_CLASS } from "@stll/ui/composer-tokens";
import { Textarea } from "@stll/ui/textarea";

import { ArrowUpIcon, PlusIcon, SquareIcon } from "@/icons.gen";
import { useUiColors } from "@/theme";

/**
 * The message box under a thread: the web's compact composer, its box from
 * the same tokens (`@stll/ui/composer-tokens`), with the (+) control, the
 * one-line text cell that grows, and the round send button. Sized for a
 * thumb rather than a pointer: body text and 36pt controls, where the web's
 * 28pt controls and 14px text read tiny on a phone. It grows with what is
 * typed up to a few lines, then scrolls. While an answer is arriving its button stops the
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
  const ui = useUiColors();
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

  const canSend = message !== "";
  // A one-line text cell is 42pt tall (24pt line, 9pt above and below); the
  // 36pt round controls sit centred on it.
  const control = "mb-[3px]";
  const sendButton = "bg-foreground size-9 shrink-0 rounded-full";

  return (
    <View className="bg-background px-3 pt-1 pb-2">
      <View className={`${COMPOSER_BOX_CLASS} border-border`}>
        <View className="min-h-[54px] flex-row items-end gap-2 px-2 py-1.5">
          <Pressable
            accessibilityLabel={t("composerMenu")}
            accessibilityRole="button"
            className={`border-border bg-secondary size-9 items-center justify-center rounded-full border ${control}`}
          >
            <PlusIcon color={ui.secondaryForeground} size={18} />
          </Pressable>
          <View className="min-w-0 flex-1 py-2.25">
            <Textarea
              accessibilityLabel={t("composerPlaceholder")}
              onChangeText={setDraft}
              placeholder={t("composerPlaceholder")}
              unstyled
              value={draft}
            />
          </View>
          {busy ? (
            <Pressable
              accessibilityLabel={t("stop")}
              accessibilityRole="button"
              accessibilityState={{ disabled: !canStop }}
              className={`items-center justify-center ${sendButton} ${control}`}
              disabled={!canStop}
              onPress={onStop}
              style={{ opacity: canStop ? 1 : 0.64 }}
            >
              <SquareIcon color={ui.background} size={16} />
            </Pressable>
          ) : (
            <Pressable
              accessibilityLabel={t("send")}
              accessibilityRole="button"
              accessibilityState={{ disabled: !canSend }}
              className={`items-center justify-center ${sendButton} ${control}`}
              disabled={!canSend}
              onPress={send}
              style={{ opacity: canSend ? 1 : 0.64 }}
            >
              <ArrowUpIcon color={ui.background} size={18} />
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
};
