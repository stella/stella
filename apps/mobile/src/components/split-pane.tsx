import type { ReactNode } from "react";

import { View } from "react-native";

import { EmptyCard } from "@/components/empty-state-screen";
import { useLayout } from "@/components/selection";
import { useAppColors } from "@/theme";

/**
 * A tab's list, and where the window has room, what is selected in it
 * beside the list, as t3code lays out an iPad: the list keeps a column of
 * its own and the selection fills the rest; on an unfolded foldable they
 * meet at the fold. With nothing selected the second column says what will
 * show there. One column shows the list alone.
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
  const colors = useAppColors();

  if (!layout.usesSplitView) {
    return list;
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
          <View className="flex-1 p-6 pt-24">
            <EmptyCard description={emptyDescription} title={emptyTitle} />
          </View>
        )}
      </View>
    </View>
  );
};
