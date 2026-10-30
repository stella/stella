// Passive regression fixture for the reader hyphenation rule.
export const _a = () => (
  // oxlint-disable-next-line no-auto-hyphenation-in-reader/no-auto-hyphenation-in-reader
  <p className="hyphens-auto" />
);
export const _b = () => (
  // oxlint-disable-next-line no-auto-hyphenation-in-reader/no-auto-hyphenation-in-reader
  <p className="md:hyphens-auto!" />
);
export const _c = () => (
  // oxlint-disable-next-line no-auto-hyphenation-in-reader/no-auto-hyphenation-in-reader
  <p className="[hyphens:auto]" />
);
export const _d = () => (
  // oxlint-disable-next-line no-auto-hyphenation-in-reader/no-auto-hyphenation-in-reader
  <p className="lg:[hyphens:auto]" />
);
// expect-clean: no-auto-hyphenation-in-reader/no-auto-hyphenation-in-reader
export const _e = () => <p className="hyphens-manual hyphens-none" />;
