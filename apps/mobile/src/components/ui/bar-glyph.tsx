import { Stack } from "expo-router";

import { BAR_GLYPHS } from "@/bar-glyphs.gen";

/**
 * A lucide glyph for a button of the platform's own header bar: the asset
 * catalog image `scripts/generate-mobile-icons.ts` draws from lucide's
 * outline, which UIKit loads by name as it builds the bar, so the button
 * never stands as its text label while the glyph loads. Drawn as a template,
 * so the bar tints it to its own colour.
 *
 * Called rather than rendered: a toolbar button reads its icon from its own
 * children, which must be the `Stack.Toolbar.Icon` element itself.
 */
export const barGlyph = (glyph: keyof typeof BAR_GLYPHS) => (
  <Stack.Toolbar.Icon renderingMode="template" xcasset={BAR_GLYPHS[glyph]} />
);
