import { Button, Host, Image, Menu } from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  contentShape,
  frame,
  glassEffect,
  shapes,
} from "@expo/ui/swift-ui/modifiers";
import { isLiquidGlassAvailable } from "expo-glass-effect";
import { View } from "react-native";
import { useTranslations } from "use-intl";

import type { ComposerAttachMenuProps } from "@/components/composer-attach-menu";
import { useUiColors } from "@/theme";

/** The round button's inside: 36pt less its border. */
const MENU_SIZE = 34;

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
  // On iOS 26 the (+) is a Liquid Glass circle, as the platform's own; before
  // it, the web's bordered round button.
  const glass = isLiquidGlassAvailable();
  const size = glass ? GLASS_SIZE : MENU_SIZE;

  return (
    <View
      className={`mb-[3px] size-9 items-center justify-center rounded-full ${glass ? "" : "border-border bg-secondary border"}`}
    >
      <Host style={{ height: size, width: size }}>
        <Menu
          label={
            <Image color={ui.secondaryForeground} size={16} systemName="plus" />
          }
          modifiers={[
            frame({ width: size, height: size }),
            contentShape(shapes.circle()),
            ...(glass
              ? [
                  glassEffect({
                    glass: { variant: "regular", interactive: true },
                    shape: "circle",
                  }),
                ]
              : []),
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
