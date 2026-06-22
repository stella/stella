// Passive regression fixture for `no-input-dir-auto/no-input-dir-auto`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag;
// if the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without
// a directive cover the allow-list and must keep passing.

// --- Flagged: dir="auto" on free-text controls (noAutoDir) ---
export const _inputAuto = () => (
  // oxlint-disable-next-line no-input-dir-auto/no-input-dir-auto
  <input dir="auto" type="text" />
);
export const _textareaAuto = () => (
  // oxlint-disable-next-line no-input-dir-auto/no-input-dir-auto
  <textarea dir="auto" />
);

// --- Flagged: numeric input without dir="ltr" (numericDir) ---
export const _numericNoDir = () => (
  // oxlint-disable-next-line no-input-dir-auto/no-input-dir-auto
  <input inputMode="decimal" placeholder="0.00" />
);

// --- Flagged: raw free-text control with no dir (rawNeedsDir) ---
export const _rawInputNoDir = () => (
  // oxlint-disable-next-line no-input-dir-auto/no-input-dir-auto
  <input type="text" />
);
export const _rawTextareaNoDir = () => (
  // oxlint-disable-next-line no-input-dir-auto/no-input-dir-auto
  <textarea />
);

// --- Allowed: structured types (exempt), forced ltr/rtl, numeric+ltr ---
export const _ok1 = () => <input type="email" />;
export const _ok2 = () => <input type="number" />;
export const _ok3 = () => <input dir="ltr" inputMode="decimal" />;
export const _ok4 = () => <input dir="ltr" type="text" />;
export const _ok5 = () => <input dir="rtl" type="text" />;
