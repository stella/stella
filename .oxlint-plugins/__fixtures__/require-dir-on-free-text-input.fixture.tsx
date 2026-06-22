// Passive regression fixture for
// `require-dir-on-free-text-input/require-dir-on-free-text-input`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST
// flag; if the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines
// without a directive cover the allow-list and must keep passing.

// --- Flagged: free-text inputs/textarea without `dir` ---
export const _typedText = () => (
  // oxlint-disable-next-line require-dir-on-free-text-input/require-dir-on-free-text-input
  <input type="text" />
);
export const _untyped = () => (
  // oxlint-disable-next-line require-dir-on-free-text-input/require-dir-on-free-text-input
  <input placeholder="name" />
);
export const _search = () => (
  // oxlint-disable-next-line require-dir-on-free-text-input/require-dir-on-free-text-input
  <input type="search" />
);
export const _textarea = () => (
  // oxlint-disable-next-line require-dir-on-free-text-input/require-dir-on-free-text-input
  <textarea />
);

// --- Allowed: `dir` present, or a structured (LTR) type ---
export const _ok1 = () => <input dir="auto" type="text" />;
export const _ok2 = () => <input type="email" />;
export const _ok3 = () => <input type="number" />;
export const _ok4 = () => <textarea dir="auto" />;
