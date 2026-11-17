type PressKitSwatch = {
  readonly name: string;
  readonly description: string;
  readonly hex: string;
};

// The swatches published to press, kept as released rather than read from
// @stll/brand: a press kit's values change only with a deliberate brand release.
export const PRESS_KIT_SWATCHES: readonly PressKitSwatch[] = [
  {
    name: "Soft Blue",
    hex: "#CFE1F9",
    description: "Hero washes, headers, supporting accent.",
  },
  {
    name: "Pale Blue",
    hex: "#E6F6FC",
    description: "Backgrounds, surfaces, light callouts.",
  },
  {
    name: "Blue Accent",
    hex: "#6B9FD0",
    description: "Primary accent: buttons, links, focus.",
  },
  {
    name: "Black",
    hex: "#000000",
    description: "Wordmark, primary text, highest contrast.",
  },
];
