// Passive regression fixture for
// `no-direct-matter-glyph/no-direct-matter-glyph`.
//
// The rule bans importing the raw matter (layers) glyph from lucide-react
// anywhere except apps/web/src/components/matter-icon.tsx. If the rule
// regresses, the disable directive below goes unused and
// `--report-unused-disable-directives-severity=error` fails CI.

// oxlint-disable-next-line no-direct-matter-glyph/no-direct-matter-glyph
import { Layers2Icon, LayersIcon } from "lucide-react";

export function DirectMatterGlyphFixture() {
  return (
    <>
      <LayersIcon />
      <Layers2Icon />
    </>
  );
}
