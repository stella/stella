import { resolveMatterColor } from "@stll/ui/matter-colors";

import { LayersIcon } from "@/icons.gen";
import { useUiColors } from "@/theme";
import type { UiColors } from "@/ui-theme.gen";

/**
 * The matter glyph, as the web's `MatterIcon` (packages/ui matter-icon.tsx)
 * draws it: lucide's layers, in the matter's own colour, resolved by the
 * web's `resolveMatterColor` (stored colour, else a swatch hashed from the id).
 */
export const MatterIcon = ({
  matter,
  size = 16,
}: {
  matter: { id: string; color?: string | null | undefined };
  size?: number;
}) => {
  const ui = useUiColors();
  return (
    <LayersIcon
      color={matterColor(
        resolveMatterColor(matter.id, matter.color ?? null),
        ui,
      )}
      size={size}
    />
  );
};

/** The matters section's own glyph: the same layers, in the muted colour. */
export const MattersNavIcon = ({
  color,
  size = 24,
}: {
  color: string;
  size?: number;
}) => <LayersIcon color={color} size={size} />;

/**
 * A CSS colour from `resolveMatterColor` as React Native reads it: a hex
 * passes through; `var(--option-blue)` is the theme's `optionBlue`.
 */
function matterColor(css: string, ui: UiColors): string {
  const option = /^var\(--option-([a-z]+)\)$/u.exec(css)?.[1];
  if (option === undefined) {
    return css;
  }
  const byName: Readonly<Record<string, string>> = ui;
  return (
    byName[`option${option.charAt(0).toUpperCase()}${option.slice(1)}`] ??
    ui.mutedForeground
  );
}
