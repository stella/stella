import { Pressable, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTranslations } from "use-intl";

import { Text } from "@stll/ui/text";

import { useLayout, useSelection } from "@/components/selection";
import { PanelLeftIcon } from "@/icons.gen";
import { useUiColors } from "@/theme";

/**
 * A selection's column: its name in a quiet bar under the bars above it,
 * the tabs' translucent header and, on an iPad, the tab bar floating at the
 * top, then its content. The view's own safe area counts both. Leading the
 * name, a button puts the list away or brings it back, as ⌘\ does; across
 * a fold the two always stay apart, so there it has none.
 */
export const Pane = ({
  children,
  title,
}: React.PropsWithChildren<{ title: string }>) => {
  const t = useTranslations("pane");
  const layout = useLayout();
  const selection = useSelection();
  const ui = useUiColors();

  return (
    <SafeAreaView className="flex-1" edges={["top"]}>
      <View className="border-border flex-row items-center gap-3 border-b px-4 py-3">
        {layout.usesSplitView && layout.divisionWidth === 0 ? (
          <Pressable
            accessibilityLabel={
              selection.listHidden ? t("showList") : t("hideList")
            }
            accessibilityRole="button"
            className="active:opacity-60"
            hitSlop={8}
            onPress={selection.toggleList}
          >
            <PanelLeftIcon color={ui.mutedForeground} size={20} />
          </Pressable>
        ) : null}
        <View className="flex-1">
          <Text accessibilityRole="header" numberOfLines={1} variant="headline">
            {title}
          </Text>
        </View>
      </View>
      {children}
    </SafeAreaView>
  );
};
