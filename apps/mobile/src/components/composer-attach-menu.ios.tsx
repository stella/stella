import { Button, Host, Image, Menu } from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  contentShape,
  frame,
  shapes,
} from "@expo/ui/swift-ui/modifiers";
import { StyleSheet, View } from "react-native";
import { useTranslations } from "use-intl";

import type { ComposerAttachMenuProps } from "@/components/composer-attach-menu";
import { useUiColors } from "@/theme";

/** The round button's inside: 36pt less its border. */
const MENU_SIZE = 34;

/**
 * The composer's (+): a tap opens the system menu of what can go into the
 * message, as the web's plus menu does: a file from Files, or a document
 * scanned with the camera where the device has one. The round button is
 * drawn here; the menu is SwiftUI's, so it looks and behaves as iOS menus do.
 */
export const ComposerAttachMenu = ({
  onAttachFile,
  onScan,
}: ComposerAttachMenuProps) => {
  const ui = useUiColors();
  const t = useTranslations("chat");

  return (
    <View className="border-border bg-secondary mb-[3px] size-9 items-center justify-center rounded-full border">
      <Host style={styles.host}>
        <Menu
          label={
            <Image color={ui.secondaryForeground} size={16} systemName="plus" />
          }
          modifiers={[
            frame({ width: MENU_SIZE, height: MENU_SIZE }),
            contentShape(shapes.circle()),
            accessibilityLabel(t("composerMenu")),
          ]}
        >
          <Button
            label={t("attachFile")}
            onPress={onAttachFile}
            systemImage="doc"
          />
          {onScan === undefined ? null : (
            <Button
              label={t("scanDocument")}
              onPress={onScan}
              systemImage="doc.viewfinder"
            />
          )}
        </Menu>
      </Host>
    </View>
  );
};

const styles = StyleSheet.create({
  host: {
    height: MENU_SIZE,
    width: MENU_SIZE,
  },
});
