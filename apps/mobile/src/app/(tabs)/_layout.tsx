import { NativeTabs } from "expo-router/unstable-native-tabs";
import { useTranslations } from "use-intl";

import { useAppColors } from "@/theme";

/**
 * The platform's own tab bar (iOS's, with its glass), each tab an SF Symbol
 * that fills when selected, tinted with the web's primary.
 */
const TabLayout = () => {
  const colors = useAppColors();
  const t = useTranslations("tabs");

  return (
    <NativeTabs
      iconColor={{ default: colors.muted, selected: colors.accent }}
      tintColor={colors.accent}
    >
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Icon
          md="chat"
          sf={{
            default: "bubble.left.and.bubble.right",
            selected: "bubble.left.and.bubble.right.fill",
          }}
        />
        <NativeTabs.Trigger.Label>{t("chat")}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="tasks">
        <NativeTabs.Trigger.Icon md="checklist" sf="checklist" />
        <NativeTabs.Trigger.Label>{t("tasks")}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="matters">
        <NativeTabs.Trigger.Icon
          md="folder"
          sf={{ default: "folder", selected: "folder.fill" }}
        />
        <NativeTabs.Trigger.Label>{t("matters")}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Icon
          md="settings"
          sf={{ default: "gearshape", selected: "gearshape.fill" }}
        />
        <NativeTabs.Trigger.Label>{t("settings")}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
};

export default TabLayout;
