import { NativeTabs } from "expo-router/unstable-native-tabs";
import { useTranslations } from "use-intl";

import { LucideGlyphs } from "@/components/ui/lucide-glyphs";
import { useAppColors } from "@/theme";

/**
 * The platform's own tab bar (iOS's, with its glass), each tab drawn with the
 * web navigation's glyph (apps/web workspace-primary-nav.ts) from lucide:
 * chat's bubble, tasks' list and the matters layers; settings opens
 * from the header, as in t3code.
 * `tab-icons.test.ts` holds them equal.
 */
const TabLayout = () => {
  const colors = useAppColors();
  const t = useTranslations("tabs");

  return (
    <NativeTabs
      iconColor={{ default: colors.muted, selected: colors.text }}
      tintColor={colors.text}
    >
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Icon
          src={
            <NativeTabs.Trigger.VectorIcon
              family={LucideGlyphs}
              name="message-square"
            />
          }
        />
        <NativeTabs.Trigger.Label>{t("chat")}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="tasks">
        <NativeTabs.Trigger.Icon
          src={
            <NativeTabs.Trigger.VectorIcon
              family={LucideGlyphs}
              name="list-todo"
            />
          }
        />
        <NativeTabs.Trigger.Label>{t("tasks")}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="matters">
        <NativeTabs.Trigger.Icon
          src={
            <NativeTabs.Trigger.VectorIcon
              family={LucideGlyphs}
              name="layers"
            />
          }
        />
        <NativeTabs.Trigger.Label>{t("matters")}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
};

export default TabLayout;
