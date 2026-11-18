import { Button } from "@stll/ui/button";

/** One of a row of choices, filled while it is the chosen one. */
export const ChoiceChip = ({
  disabled = false,
  label,
  onPress,
  selected,
}: {
  disabled?: boolean;
  label: string;
  onPress: () => void;
  selected: boolean;
}) => (
  <Button
    accessibilityRole="radio"
    accessibilityState={{ selected }}
    disabled={disabled}
    onPress={onPress}
    size="chip"
    variant={selected ? "default" : "outline"}
  >
    {label}
  </Button>
);
