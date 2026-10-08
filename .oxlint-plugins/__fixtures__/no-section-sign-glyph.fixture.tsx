// Passive regression fixture for `no-section-sign-glyph/no-section-sign-glyph`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag; if
// the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without a
// directive cover the allow-list and must keep passing.

// --- Flagged: the whole content is the glyph ---
export const _a = () => (
  <div className="mark">
    {/* oxlint-disable-next-line no-section-sign-glyph/no-section-sign-glyph */}
    {"§"}
  </div>
);
// oxlint-disable-next-line no-section-sign-glyph/no-section-sign-glyph
export const _b = () => <span title="§" />;

// --- Allowed: legal text and parser data ---
export const _c = () => <span>§ 10 or a heading</span>;
export const _d = () => <span title="§§ 2-4" />;
export const marker = "§";
