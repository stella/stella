import { useState } from "react";

import { Pressable, View } from "react-native";
import { useTranslations } from "use-intl";

import {
  COMPOSER_BOX_CLASS,
  COMPOSER_LARGE_EDITOR_CLASS,
} from "@stll/ui/composer-tokens";
import { Textarea } from "@stll/ui/textarea";

import { ArrowUpIcon, PlusIcon, SquareIcon } from "@/icons.gen";
import { useUiColors } from "@/theme";

/**
 * The message box: the web's large composer, its box from the same tokens
 * (`@stll/ui/composer-tokens`). The text sits on top, three lines tall
 * before it grows, then a row with the (+) control and the round send
 * button. Sized for a thumb: body text and 36pt controls. It grows with what
 * is typed up to a few lines, then scrolls. While an answer is arriving its
 * button stops the answer instead of sending; it can stop once the server
 * has named the turn. With nothing to send, the button is drawn muted rather
 * than dimmed, so it never reads as ready.
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
  const round = "size-9 shrink-0 items-center justify-center rounded-full";
  const ready = `${round} bg-foreground`;
  const muted = `${round} bg-secondary`;

  return (
    <View className="bg-background px-3 pt-1 pb-2">
      <View className={`${COMPOSER_BOX_CLASS} border-border`}>
        <View className="px-3.5 pt-3 pb-1">
          <Textarea
            accessibilityLabel={t("composerPlaceholder")}
            // Three lines tall, all of it a place to tap and type.
            className={`${COMPOSER_LARGE_EDITOR_CLASS} max-h-40`}
            onChangeText={setDraft}
            placeholder={t("composerPlaceholder")}
            unstyled
            value={draft}
          />
        </View>
        <View className="flex-row items-center justify-between px-2 pb-2">
          <Pressable
            accessibilityLabel={t("composerMenu")}
            accessibilityRole="button"
            className={`border-border bg-secondary border ${round}`}
          >
            <PlusIcon color={ui.secondaryForeground} size={18} />
          </Pressable>
          {busy ? (
            <Pressable
              accessibilityLabel={t("stop")}
              accessibilityRole="button"
              accessibilityState={{ disabled: !canStop }}
              className={canStop ? ready : muted}
              disabled={!canStop}
              onPress={onStop}
            >
              <SquareIcon
                color={canStop ? ui.background : ui.mutedForeground}
                size={16}
              />
            </Pressable>
          ) : (
            <Pressable
              accessibilityLabel={t("send")}
              accessibilityRole="button"
              accessibilityState={{ disabled: !canSend }}
              className={canSend ? ready : muted}
              disabled={!canSend}
              onPress={send}
            >
              <ArrowUpIcon
                color={canSend ? ui.background : ui.mutedForeground}
                size={18}
              />
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
};
