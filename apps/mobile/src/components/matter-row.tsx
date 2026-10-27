import { StyleSheet, Text, View } from "react-native";
import { useFormatter } from "use-intl";

import type { MatterSummary } from "@/state/matters";
import { useAppColors } from "@/theme";

/**
 * One matter: its name, then reference, client and last activity. Activity
 * is relative to when the list was loaded, so a row reads the same on every
 * render until the next refresh.
 */
export const MatterRow = ({
  loadedAt,
  matter,
}: {
  loadedAt: number;
  matter: MatterSummary;
}) => {
  const colors = useAppColors();
  const format = useFormatter();
  const activity =
    matter.lastActivityAt === null || matter.lastActivityAt === undefined
      ? undefined
      : format.relativeTime(new Date(matter.lastActivityAt), loadedAt);
  const details = [
    matter.reference,
    matter.client?.displayName,
    activity,
  ].filter(
    (detail): detail is string =>
      detail !== undefined && detail !== null && detail !== "",
  );

  return (
    <View
      style={[
        styles.row,
        { backgroundColor: colors.card, borderColor: colors.border },
      ]}
    >
      <Text numberOfLines={2} style={[styles.name, { color: colors.text }]}>
        {matter.name}
      </Text>
      {details.length === 0 ? null : (
        <Text
          numberOfLines={1}
          style={[styles.details, { color: colors.muted }]}
        >
          {details.join(" · ")}
        </Text>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  details: {
    fontSize: 14,
  },
  name: {
    fontSize: 17,
    fontWeight: "600",
  },
  row: {
    borderRadius: 16,
    borderWidth: 1,
    gap: 4,
    marginBottom: 10,
    padding: 16,
  },
});
