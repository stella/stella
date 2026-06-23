// Passive regression fixture for
// `no-centered-scroll-column/no-centered-scroll-column`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag; if
// the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without a
// directive cover the allow-list and must keep passing.

// --- Flagged: centered, width-capped column that owns the vertical scroll ---
export const _a = () => (
  // oxlint-disable-next-line no-centered-scroll-column/no-centered-scroll-column
  <div className="mx-auto w-full max-w-2xl overflow-y-auto p-6" />
);
export const _b = () => (
  // oxlint-disable-next-line no-centered-scroll-column/no-centered-scroll-column
  <div className="mx-auto max-w-lg overflow-y-scroll" />
);
export const _c = () => (
  // oxlint-disable-next-line no-centered-scroll-column/no-centered-scroll-column
  <div className="max-w-[42rem] overflow-auto sm:mx-auto" />
);

// --- Allowed: scroll on a full-width parent, centering on the inner wrapper ---
export const _ok1 = () => (
  <div className="flex-1 overflow-y-auto">
    <div className="mx-auto w-full max-w-2xl p-6" />
  </div>
);
// Allowed: popover/menu positions itself and scrolls its own max-w box.
export const _ok2 = () => (
  <div className="absolute z-50 mx-auto max-w-[30rem] overflow-y-auto" />
);
// Allowed: self-contained scroll box (bounded height) e.g. dialog/dropdown.
export const _ok3 = () => (
  <div className="mx-auto max-h-[80vh] max-w-md overflow-y-auto" />
);
// Allowed: centered, width-capped, but no scroll.
export const _ok4 = () => <div className="mx-auto w-full max-w-2xl p-6" />;
// Allowed: full-width scroll, no width cap.
export const _ok5 = () => <div className="flex-1 overflow-y-auto" />;
// Allowed: max-w-full does not constrain to a narrow column.
export const _ok6 = () => (
  <div className="mx-auto max-w-full overflow-y-auto" />
);
