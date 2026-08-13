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
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals -- fixture proves ambient dates are not SSR-safe
const today = new Date();
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals -- fixture proves ambient randomness is not SSR-safe
const randomWidth = Math.random();
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals -- fixture proves implicit Intl locales are not SSR-safe
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const serverRequestUrl = new URL("https://example.test/law/cases");
const serializedFilter = JSON.stringify({ court: "supreme" });
const fixedDate = new Date("2026-08-13T00:00:00Z");
const fixedSegmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const readShadowedNavigator = (navigator: { language: string }) =>
  navigator.language;
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals -- fixture proves shorthand values remain real browser-global references
const shorthandBrowserGlobal = { navigator };
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals -- fixture proves globalThis cannot bypass the browser-global detector
const globalBrowserStorage = globalThis.localStorage;

export {
  browserLocale,
  fixedDate,
  fixedSegmenter,
  globalBrowserStorage,
  openedAt,
  prefersDark,
  randomWidth,
  readShadowedNavigator,
  savedFilter,
  segmenter,
  shorthandBrowserGlobal,
  serializedFilter,
  serverRequestUrl,
  today,
  viewportWidth,
};
