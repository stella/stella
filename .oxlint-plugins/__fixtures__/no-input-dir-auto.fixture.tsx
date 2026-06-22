// Passive regression fixture for `no-input-dir-auto/no-input-dir-auto`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag;
// if the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without
// a directive cover the allow-list and must keep passing.

// --- Flagged: dir="auto" on free-text controls (components own direction) ---
export const _inputAuto = () => (
  // oxlint-disable-next-line no-input-dir-auto/no-input-dir-auto
  <input dir="auto" type="text" />
);
export const _searchAuto = () => (
  // oxlint-disable-next-line no-input-dir-auto/no-input-dir-auto
  <input dir="auto" type="search" />
);
export const _textareaAuto = () => (
  // oxlint-disable-next-line no-input-dir-auto/no-input-dir-auto
  <textarea dir="auto" />
);

// --- Flagged: numeric input without dir="ltr" ---
export const _numericNoDir = () => (
  // oxlint-disable-next-line no-input-dir-auto/no-input-dir-auto
  <input inputMode="decimal" placeholder="0.00" />
);

// --- Allowed: no dir (component decides), forced ltr/rtl, structured type,
//     numeric+ltr, or a computed dir expression ---
export const _ok1 = () => <input type="text" />;
export const _ok2 = () => <textarea />;
export const _ok3 = () => <input type="email" />;
export const _ok4 = () => <input type="number" />;
export const _ok5 = () => <input dir="ltr" inputMode="decimal" />;
export const _ok6 = () => <input dir="rtl" type="text" />;
