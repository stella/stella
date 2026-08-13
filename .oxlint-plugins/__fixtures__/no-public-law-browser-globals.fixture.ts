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
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals -- fixture proves bare location is browser-only
const browserPath = location.pathname;
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals -- fixture proves browser self access is not SSR-safe
const browserSelf = self;
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals -- fixture proves browser display state is not SSR-safe
const pixelRatio = devicePixelRatio;
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals -- fixture proves ambient clocks are not SSR-safe
const openedAt = Date.now();
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals -- fixture proves zero-argument Date calls are ambient clocks too
const openedAtLabel = Date();
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals -- fixture proves ambient dates are not SSR-safe
const today = new Date();
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals -- fixture proves ambient randomness is not SSR-safe
const randomWidth = Math.random();
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals -- fixture proves high-resolution ambient clocks are not SSR-safe
const measuredAt = performance.now();
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals -- fixture proves ambient UUID generation is not SSR-safe
const randomId = crypto.randomUUID();
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals -- fixture proves globalThis cannot bypass ambient randomness detection
const globalRandomBytes = globalThis.crypto.getRandomValues(new Uint8Array(8));
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals, typescript/dot-notation -- fixture proves computed globalThis crypto access cannot bypass ambient randomness detection
const computedGlobalRandomId = globalThis["crypto"].randomUUID();
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals, typescript/dot-notation -- fixture proves a computed ambient method cannot bypass the detector
const computedRandomId = crypto["randomUUID"]();
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals, typescript/dot-notation -- fixture proves a fully computed globalThis call cannot bypass the detector
const fullyComputedGlobalRandomId = globalThis["crypto"]["randomUUID"]();
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
const readWrappedShadowedClock = (Date: { now: () => number } | null) =>
  // oxlint-disable-next-line typescript/no-non-null-assertion -- fixture proves a wrapped local binding remains unrelated to the ambient Date global
  Date!.now();
type DomainFields = { document: string; navigator: () => string };
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals -- fixture proves shorthand values remain real browser-global references
const shorthandBrowserGlobal = { navigator };
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals -- fixture proves globalThis cannot bypass the browser-global detector
const globalBrowserStorage = globalThis.localStorage;
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals, typescript/dot-notation -- fixture proves computed globalThis access cannot bypass the browser-global detector
const computedGlobalBrowserStorage = globalThis["localStorage"];
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals, typescript/no-unnecessary-type-assertion -- fixture proves TS wrappers cannot bypass globalThis member detection
const assertedGlobalBrowserLocale = (globalThis as typeof globalThis).navigator;
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals -- fixture proves destructuring cannot rename a browser global out of detection
const { navigator: browserNavigator } = globalThis;
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals, typescript/no-non-null-assertion -- fixture proves non-null assertions cannot bypass destructuring detection
const { document: browserDocument } = globalThis!;
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals, eslint/no-useless-computed-key, typescript/no-unnecessary-type-assertion -- fixture proves computed destructuring and TS wrappers cannot bypass alias detection
const { ["localStorage"]: browserStorage } = globalThis as typeof globalThis;
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals -- fixture proves an empty locale list is still an ambient Intl locale
const emptyLocaleSegmenter = new Intl.Segmenter([], {
  granularity: "grapheme",
});
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals -- fixture proves call-form Intl constructors reject an empty locale list too
const emptyLocaleDateFormatter = Intl.DateTimeFormat([], {
  dateStyle: "long",
});
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals, typescript/consistent-type-assertions -- fixture proves angle-bracket TS assertions cannot disguise an empty locale list
const assertedEmptyLocaleDateFormatter = Intl.DateTimeFormat(<string[]>[], {
  dateStyle: "long",
});
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals -- fixture proves globalThis Date cannot bypass ambient clock detection
const globalOpenedAt = globalThis.Date.now();
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals, unicorn/new-for-builtins -- fixture proves globalThis Date calls cannot bypass ambient clock detection
const globalOpenedAtLabel = globalThis.Date();
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals -- fixture proves globalThis Date construction cannot bypass ambient clock detection
const globalToday = new globalThis.Date();
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals -- fixture proves globalThis Math cannot bypass ambient randomness detection
const globalRandomWidth = globalThis.Math.random();
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals -- fixture proves globalThis Intl cannot bypass implicit-locale detection
const globalDateFormatter = new globalThis.Intl.DateTimeFormat([]);

const explicitLocaleListSegmenter = new Intl.Segmenter(["en"], {
  granularity: "grapheme",
});
const explicitLocaleListDateFormatter = Intl.DateTimeFormat(["en"], {
  dateStyle: "long",
});
const runtimeState = { navigator: { language: "en" } };
const { navigator: configuredNavigator } = runtimeState;
// oxlint-disable-next-line no-shadow-restricted-names -- fixture proves a locally bound globalThis-shaped value remains unrelated
const readShadowedGlobalThis = (globalThis: {
  navigator: { language: string };
}) => {
  const { navigator: shadowedNavigator } = globalThis;
  return shadowedNavigator.language;
};

export {
  assertedEmptyLocaleDateFormatter,
  assertedGlobalBrowserLocale,
  browserDocument,
  browserLocale,
  browserNavigator,
  browserStorage,
  browserPath,
  browserSelf,
  configuredNavigator,
  computedGlobalBrowserStorage,
  computedGlobalRandomId,
  computedRandomId,
  dateFormatter,
  emptyLocaleDateFormatter,
  emptyLocaleSegmenter,
  explicitLocaleListDateFormatter,
  explicitLocaleListSegmenter,
  fixedDate,
  fixedDateFormatter,
  fixedSegmenter,
  fullyComputedGlobalRandomId,
  globalBrowserStorage,
  globalDateFormatter,
  globalOpenedAt,
  globalOpenedAtLabel,
  globalRandomWidth,
  globalToday,
  globalRandomBytes,
  measuredAt,
  openedAt,
  openedAtLabel,
  prefersDark,
  pixelRatio,
  randomId,
  randomWidth,
  readShadowedNavigator,
  readShadowedClock,
  readShadowedGlobalThis,
  readShadowedRandom,
  readWrappedShadowedClock,
  savedFilter,
  segmenter,
  shorthandBrowserGlobal,
  serializedFilter,
  serverRequestUrl,
  today,
  viewportWidth,
};

export type { DomainFields };
