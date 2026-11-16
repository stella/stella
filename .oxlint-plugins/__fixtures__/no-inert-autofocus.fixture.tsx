// Passive regression fixture for `no-inert-autofocus/no-inert-autofocus`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag; if
// the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without a
// directive cover the allow-list and must keep passing.

// --- Flagged: intrinsic elements React never autofocuses ---
// oxlint-disable-next-line no-inert-autofocus/no-inert-autofocus
export const _a = () => <div autoFocus contentEditable />;

// --- Allowed: form controls and components ---
// expect-clean: no-inert-autofocus/no-inert-autofocus
export const _b = () => <input autoFocus />;
const Field = (_props: { autoFocus: boolean }) => null;
export const _c = () => <Field autoFocus />;
