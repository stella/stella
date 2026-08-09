// Passive regression fixture for
// `no-inline-style-colors/no-inline-style-colors`.

export const unsafeStyles = {
  // MUST flag: colors embedded in shorthand properties bypass theme tokens.
  // oxlint-disable-next-line no-inline-style-colors/no-inline-style-colors -- fixture: embedded hex colors must be rejected
  border: "1px solid #fff",

  // MUST flag: functional color syntax is equally theme-unsafe.
  // oxlint-disable-next-line no-inline-style-colors/no-inline-style-colors -- fixture: rgb colors must be rejected
  shadow: "0 1px 2px rgb(0 0 0 / 50%)",

  // MUST flag: named colors cannot adapt to dark mode.
  // oxlint-disable-next-line no-inline-style-colors/no-inline-style-colors -- fixture: named colors must be rejected
  textDecoration: "underline red",
};

// Allowed: CSS variables own both the token and any fallback expression.
export const tokenStyles = {
  border: "1px solid var(--border-color, #fff)",
  color: "var(--foreground)",
};

// Allowed: color words embedded in CSS property names are not color values.
export const unrelatedText = {
  declaration: "white-space: nowrap",
};
