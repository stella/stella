import { useHeaderHeight } from "expo-router/react-navigation";
import { View } from "react-native";

import { Text } from "@/components/ui/text";

/**
 * A selection's column: its name in a quiet bar under the tabs' header,
 * which is translucent and spans both columns, then its content.
 */
export const Pane = ({
  children,
  title,
}: React.PropsWithChildren<{ title: string }>) => {
  const headerHeight = useHeaderHeight();

  return (
    <View className="flex-1" style={{ paddingTop: headerHeight }}>
      <View className="border-border border-b px-6 py-3">
        <Text accessibilityRole="header" numberOfLines={1} variant="headline">
          {title}
        </Text>
      </View>
      {children}
    </View>
  );
};
