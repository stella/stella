import { View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Text } from "@/components/ui/text";

/**
 * A selection's column: its name in a quiet bar under the bars above it,
 * the tabs' translucent header and, on an iPad, the tab bar floating at the
 * top, then its content. The view's own safe area counts both.
 */
export const Pane = ({
  children,
  title,
}: React.PropsWithChildren<{ title: string }>) => (
  <SafeAreaView className="flex-1" edges={["top"]}>
    <View className="border-border border-b px-6 py-3">
      <Text accessibilityRole="header" numberOfLines={1} variant="headline">
        {title}
      </Text>
    </View>
    {children}
  </SafeAreaView>
);
