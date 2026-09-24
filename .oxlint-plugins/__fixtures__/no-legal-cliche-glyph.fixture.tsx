// Passive regression fixture for
// `no-legal-cliche-glyph/no-legal-cliche-glyph`.
//
// The rule bans the scales-of-justice and gavel glyphs outright: at the
// import, at a JSX element, and at a reference handed to another component as
// a prop. If any of those detectors regresses, its disable directive goes
// unused and `--report-unused-disable-directives-severity=error` fails CI.

import {
  // oxlint-disable-next-line no-legal-cliche-glyph/no-legal-cliche-glyph -- the banned import itself
  GavelIcon,
  Scale3dIcon,
  // oxlint-disable-next-line no-legal-cliche-glyph/no-legal-cliche-glyph -- an alias hides nothing
  Scale as JusticeIcon,
} from "lucide-react";

const Icon = ({ as: As }: { as: typeof Scale3dIcon }) => <As />;

export const LegalClicheGlyphFixture = () => (
  <>
    {/* oxlint-disable-next-line no-legal-cliche-glyph/no-legal-cliche-glyph -- the JSX element */}
    <GavelIcon />
    {/* oxlint-disable-next-line no-legal-cliche-glyph/no-legal-cliche-glyph -- the prop reference */}
    <Icon as={JusticeIcon} />
    {/* A geometry transform, not a balance: the rule matches exact names. */}
    {/* expect-clean: no-legal-cliche-glyph/no-legal-cliche-glyph */}
    <Scale3dIcon />
  </>
);
