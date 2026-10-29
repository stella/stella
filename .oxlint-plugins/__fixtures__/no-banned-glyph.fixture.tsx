/* oxlint-disable no-direct-lucide-import/no-direct-lucide-import -- fixture: the glyphs come straight from lucide */

// Passive regression fixture for
// `no-banned-glyph/no-banned-glyph`.
//
// The rule bans the scales-of-justice, gavel and robot glyphs outright: at the
// import, at a JSX element, and at a reference handed to another component as
// a prop. If any of those detectors regresses, its disable directive goes
// unused and `--report-unused-disable-directives-severity=error` fails CI.

import {
  // oxlint-disable-next-line no-banned-glyph/no-banned-glyph -- a robot personifies the AI
  BotIcon,
  // oxlint-disable-next-line no-banned-glyph/no-banned-glyph -- the banned import itself
  GavelIcon,
  Scale3dIcon,
  // oxlint-disable-next-line no-banned-glyph/no-banned-glyph -- an alias hides nothing
  Scale as JusticeIcon,
} from "lucide-react";

// oxlint-disable-next-line no-banned-glyph/no-banned-glyph -- through the shared icon module
import { ScaleIcon as IconModuleScale } from "@stll/ui/icons";

// oxlint-disable-next-line no-banned-glyph/no-banned-glyph -- the icon module may not re-export it either
export { Gavel as ReexportedGavel } from "lucide-react";

const Icon = ({ as: As }: { as: typeof Scale3dIcon }) => <As />;

export const BannedGlyphFixture = () => (
  <>
    {/* oxlint-disable-next-line no-banned-glyph/no-banned-glyph -- the JSX element */}
    <GavelIcon />
    {/* oxlint-disable-next-line no-banned-glyph/no-banned-glyph -- the robot element */}
    <BotIcon />
    {/* oxlint-disable-next-line no-banned-glyph/no-banned-glyph -- the prop reference */}
    <Icon as={JusticeIcon} />
    {/* oxlint-disable-next-line no-banned-glyph/no-banned-glyph -- the icon module's binding */}
    <IconModuleScale />
    {/* A geometry transform, not a balance: the rule matches exact names. */}
    {/* expect-clean: no-banned-glyph/no-banned-glyph */}
    <Scale3dIcon />
  </>
);
