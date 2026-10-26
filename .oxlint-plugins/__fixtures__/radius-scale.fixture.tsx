// Passive regression fixture for `radius-scale/radius-scale`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag; if
// the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without a
// directive cover the allow-list and must keep passing.

// --- Flagged: the bare spelling of the 4px step ---
export const _a = () => (
  // oxlint-disable-next-line radius-scale/radius-scale
  <span className="rounded px-1" />
);
export const _b = () => (
  // oxlint-disable-next-line radius-scale/radius-scale
  <span className="hover:rounded-t" />
);

// --- Flagged: a literal radius between steps ---
export const _c = () => (
  // oxlint-disable-next-line radius-scale/radius-scale
  <div className="rounded-[7px] border" />
);

// --- Accepted: named steps and token-derived values ---
export const _d = () => (
  <div className="rounded-lg before:rounded-[calc(var(--radius-lg)-1px)]" />
);
export const _e = () => <span className="rounded-sm rounded-t-sm" />;
