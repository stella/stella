import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { COMPOSER_CONTROL_BUTTON_SIZE } from "@stll/ui/composer-tokens";

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
    <Button
      accessibilityLabel={t("attachFile")}
      className="border-border mb-[3px] size-9 rounded-full"
      onPress={onAttachFile}
      size={COMPOSER_CONTROL_BUTTON_SIZE}
      variant="secondary"
    >
      <PlusIcon color={ui.secondaryForeground} size={18} />
    </Button>
  );
};
