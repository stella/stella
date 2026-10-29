import { useState } from "react";

import { View } from "react-native";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  COMPOSER_BOX_CLASS,
  COMPOSER_COMPACT_ROW_CLASS,
  COMPOSER_COMPACT_TEXT_CELL_CLASS,
  COMPOSER_CONTROL_BUTTON_SIZE,
  COMPOSER_SEND_BUTTON_CLASS,
} from "@stll/ui/composer-tokens";
import { Textarea } from "@stll/ui/textarea";

import { ArrowUpIcon, PlusIcon, SquareIcon } from "@/icons.gen";
import { useUiColors } from "@/theme";

/**
 * The message box under a thread: the web's compact composer, from the same
 * tokens (`@stll/ui/composer-tokens`): the rounded box, the (+) control, the
 * one-line text cell that grows, and the round send button. It grows with
 * what is typed up to a few lines, then scrolls. While an answer is arriving its button stops the
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
  // A one-line text cell is 42pt tall; the 28pt round controls sit centred
  // on it, as the web's do on its one-line row.
  const control = "mb-[7px]";

  return (
    <View className="bg-background px-3 pt-1 pb-2">
      <View className={`${COMPOSER_BOX_CLASS} border-border`}>
        <View className={`flex-row ${COMPOSER_COMPACT_ROW_CLASS}`}>
          {/* The web's composer menu trigger (composer-plus-menu.tsx): a
              secondary round control at the composer's control size. */}
          <Button
            accessibilityLabel={t("composerMenu")}
            className={`border-border size-7 shrink-0 rounded-full border ${control}`}
            size={COMPOSER_CONTROL_BUTTON_SIZE}
            variant="secondary"
          >
            <PlusIcon color={ui.secondaryForeground} size={16} />
          </Button>
          <View className={`flex-1 ${COMPOSER_COMPACT_TEXT_CELL_CLASS}`}>
            <Textarea
              accessibilityLabel={t("composerPlaceholder")}
              onChangeText={setDraft}
              placeholder={t("composerPlaceholder")}
              size="sm"
              unstyled
              value={draft}
            />
          </View>
          {busy ? (
            <Button
              accessibilityLabel={t("stop")}
              className={`${COMPOSER_SEND_BUTTON_CLASS} ${control}`}
              disabled={!canStop}
              onPress={onStop}
              size={COMPOSER_CONTROL_BUTTON_SIZE}
            >
              <SquareIcon color={ui.background} size={14} />
            </Button>
          ) : (
            <Button
              accessibilityLabel={t("send")}
              className={`${COMPOSER_SEND_BUTTON_CLASS} ${control}`}
              disabled={!canSend}
              onPress={send}
              size={COMPOSER_CONTROL_BUTTON_SIZE}
            >
              <ArrowUpIcon color={ui.background} size={14} />
            </Button>
          )}
        </View>
      </View>
    </View>
  );
};
