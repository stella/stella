import { Button, Host, Image, Menu } from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  contentShape,
  frame,
  glassEffect,
  shapes,
} from "@expo/ui/swift-ui/modifiers";
import { StyleSheet, View } from "react-native";
import { useTranslations } from "use-intl";

import type { ComposerAttachMenuProps } from "@/components/composer-attach-menu";
import { useUiColors } from "@/theme";

/** A Liquid Glass button has no border to make room for. */
const GLASS_SIZE = 36;

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
    <View className="mb-[3px] size-9 items-center justify-center rounded-full">
      <Host style={styles.glassHost}>
        <Menu
          label={
            <Image color={ui.secondaryForeground} size={16} systemName="plus" />
          }
          modifiers={[
            frame({ width: GLASS_SIZE, height: GLASS_SIZE }),
            contentShape(shapes.circle()),
            glassEffect({
              glass: { variant: "regular", interactive: true },
              shape: "circle",
            }),
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
  glassHost: {
    height: GLASS_SIZE,
    width: GLASS_SIZE,
  },
});
