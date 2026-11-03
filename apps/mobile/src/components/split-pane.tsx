import type { ReactNode } from "react";

import { View } from "react-native";

import { Text } from "@stll/ui/text";

import { useLayout, useSelection } from "@/components/selection";
import { useAppColors } from "@/theme";

/**
 * A tab's list, and where the window has room, what is selected in it
 * beside the list, as t3code lays out an iPad: the list keeps a column of
 * its own and the selection fills the rest; on an unfolded foldable they
 * meet at the fold. With nothing selected the second column says what will
 * show there. One column shows the list alone. Put away, with ⌘\ or the
 * selection's own button, the list leaves the selection the whole window,
 * except across a fold, which still parts the two.
 */
export const SplitPane = ({
  detail,
  emptyDescription,
  emptyTitle,
  list,
}: {
  /** What is selected, or null when nothing is. */
  detail: ReactNode;
  emptyDescription: string;
  emptyTitle: string;
  list: ReactNode;
}) => {
  const layout = useLayout();
  const selection = useSelection();
  const colors = useAppColors();

  if (!layout.usesSplitView) {
    return <View className="flex-1">{list}</View>;
  }
  if (selection.listHidden && layout.divisionWidth === 0 && detail !== null) {
    return (
      <View className="flex-1" style={{ backgroundColor: colors.background }}>
        {detail}
      </View>
    );
  }
  return (
    <View className="flex-1 flex-row">
      <View
        className={layout.divisionWidth === 0 ? "border-border border-r" : ""}
        style={{ width: layout.listPaneWidth }}
      >
        {list}
      </View>
      {/* A fold between the columns holds nothing. */}
      <View style={{ width: layout.divisionWidth }} />
      <View className="flex-1" style={{ backgroundColor: colors.background }}>
        {detail ?? (
          <View className="flex-1 items-center justify-center gap-2 p-8">
            <Text variant="headline">{emptyTitle}</Text>
            <Text className="max-w-90 text-center" variant="caption">
              {emptyDescription}
            </Text>
          </View>
        )}
      </View>
    </View>
  );
};
