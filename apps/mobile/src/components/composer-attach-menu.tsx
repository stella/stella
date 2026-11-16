import { Pressable } from "react-native";
import { useTranslations } from "use-intl";

import { PlusIcon } from "@/icons.gen";
import { useUiColors } from "@/theme";

export type ComposerAttachMenuProps = {
  /** Opens the system document picker. */
  onAttachFile: () => void;
  /** Opens the document camera; absent where the device has none. */
  onScan: (() => void) | undefined;
};

/**
 * The composer's (+) where the system menu is not available: the document
 * camera is iOS's, so attaching a file is all it offers, and it opens the
 * document picker straight away.
 */
export const ComposerAttachMenu = ({
  onAttachFile,
}: ComposerAttachMenuProps) => {
  const ui = useUiColors();
  const t = useTranslations("chat");

  return (
    <Pressable
      accessibilityLabel={t("attachFile")}
      accessibilityRole="button"
      className="border-border bg-secondary mb-[3px] size-9 items-center justify-center rounded-full border"
      onPress={onAttachFile}
    >
      <PlusIcon color={ui.secondaryForeground} size={18} />
    </Pressable>
  );
};
