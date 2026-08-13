/* oxlint-disable unicorn/new-for-builtins -- fixture intentionally exercises a zero-argument Date call */
// Passive regression fixture for
// `no-public-law-browser-globals/no-public-law-browser-globals`.

// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals -- fixture proves direct DOM access is not SSR-safe
const viewportWidth = window.innerWidth;
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals -- fixture proves browser storage is not SSR-safe
const savedFilter = localStorage.getItem("case-law-filter");
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals -- fixture proves media queries are browser-only
const prefersDark = matchMedia("(prefers-color-scheme: dark)").matches;
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals -- fixture proves browser locale access is not SSR-safe
const browserLocale = navigator.language;
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals -- fixture proves ambient clocks are not SSR-safe
const openedAt = Date.now();
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals -- fixture proves zero-argument Date calls are ambient clocks too
const openedAtLabel = Date();
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals -- fixture proves ambient dates are not SSR-safe
const today = new Date();
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals -- fixture proves ambient randomness is not SSR-safe
const randomWidth = Math.random();
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals -- fixture proves implicit Intl locales are not SSR-safe
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals -- fixture proves call-form Intl constructors also need an explicit locale
const dateFormatter = Intl.DateTimeFormat(undefined, { dateStyle: "long" });

const serverRequestUrl = new URL("https://example.test/law/cases");
const serializedFilter = JSON.stringify({ court: "supreme" });
const fixedDate = new Date("2026-08-13T00:00:00Z");
const fixedSegmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const fixedDateFormatter = Intl.DateTimeFormat("en", { dateStyle: "long" });
const readShadowedNavigator = (navigator: { language: string }) =>
  navigator.language;
const readShadowedClock = (Date: () => string) => Date;
const readShadowedRandom = (Math: { random: () => number }) => Math.random();
type DomainFields = { document: string; navigator: () => string };
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals -- fixture proves shorthand values remain real browser-global references
const shorthandBrowserGlobal = { navigator };
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals -- fixture proves globalThis cannot bypass the browser-global detector
const globalBrowserStorage = globalThis.localStorage;
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals -- fixture proves computed globalThis access cannot bypass the browser-global detector
const computedGlobalBrowserStorage = globalThis["localStorage"];

export {
  browserLocale,
  computedGlobalBrowserStorage,
  dateFormatter,
  fixedDate,
  fixedDateFormatter,
  fixedSegmenter,
  globalBrowserStorage,
  openedAt,
  openedAtLabel,
  prefersDark,
  randomWidth,
  readShadowedNavigator,
  readShadowedClock,
  readShadowedRandom,
  savedFilter,
  segmenter,
  shorthandBrowserGlobal,
  serializedFilter,
  serverRequestUrl,
  today,
  viewportWidth,
};

export type { DomainFields };
