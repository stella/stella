// Passive regression fixture for
// `no-inline-style-colors/no-inline-style-colors`.

export const UnsafeStyles = () => (
  <div
    style={{
      // MUST flag: colors embedded in shorthand properties bypass theme tokens.
      // oxlint-disable-next-line no-inline-style-colors/no-inline-style-colors -- fixture: embedded hex colors must be rejected
      border: "1px solid #fff",

      // MUST flag: functional color syntax is equally theme-unsafe.
      // oxlint-disable-next-line no-inline-style-colors/no-inline-style-colors -- fixture: rgb colors must be rejected
      boxShadow: "0 1px 2px rgb(0 0 0 / 50%)",

      // MUST flag: named colors cannot adapt to dark mode.
      // oxlint-disable-next-line no-inline-style-colors/no-inline-style-colors -- fixture: named colors must be rejected
      textDecoration: "underline red",
    }}
  />
);

export const TokenStyles = () => (
  <div
    style={{
      border: "1px solid var(--border-color, #fff)",
      color: "var(--foreground)",
    }}
  />
);

// Domain/config objects are not style sinks. Color-like labels here must not
// trigger the detector.
export const unrelatedData = {
  declaration: "white-space: nowrap",
  option: "red",
};
