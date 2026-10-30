import { ActivityIndicator } from "react-native";

import { Button } from "@stll/ui/button";

import { useAppColors } from "@/theme";

/** The outlined button a failed load offers to run again. */
export const RetryButton = ({
  label,
  onPress,
}: {
  label: string;
  onPress: () => void;
}) => (
  <Button className="mt-3 self-center" onPress={onPress} variant="outline">
    {label}
  </Button>
);

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
    return <ActivityIndicator className="py-3" color={colors.muted} />;
  }
  if (state === "failed") {
    return <RetryButton label={label} onPress={onRetry} />;
  }
  return null;
};
