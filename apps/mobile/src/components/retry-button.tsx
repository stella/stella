import { ActivityIndicator, Pressable, StyleSheet, Text } from "react-native";

import { useAppColors } from "@/theme";

/** The outlined button a failed load offers to run again. */
export const RetryButton = ({
  label,
  onPress,
}: {
  label: string;
  onPress: () => void;
}) => {
  const colors = useAppColors();

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.retry, { borderColor: colors.border }]}
    >
      <Text style={[styles.retryLabel, { color: colors.accent }]}>{label}</Text>
    </Pressable>
  );
};

/** Where loading the next page of a list stands. */
export type PagingState = "idle" | "loading" | "failed";

/** The end of a paged list: a spinner while the next page loads, a retry when it failed, else nothing. */
export const PagingFooter = ({
  label,
  onRetry,
  state,
}: {
  label: string;
  onRetry: () => void;
  state: PagingState;
}) => {
  const colors = useAppColors();
  if (state === "loading") {
    return <ActivityIndicator color={colors.muted} style={styles.paging} />;
  }
  if (state === "failed") {
    return <RetryButton label={label} onPress={onRetry} />;
  }
  return null;
};

const styles = StyleSheet.create({
  paging: {
    paddingVertical: 12,
  },
  retry: {
    alignSelf: "center",
    borderRadius: 12,
    borderWidth: 1,
    marginTop: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  retryLabel: {
    fontSize: 16,
    fontWeight: "600",
  },
});
