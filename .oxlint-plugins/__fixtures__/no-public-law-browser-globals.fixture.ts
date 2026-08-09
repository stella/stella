// Passive regression fixture for
// `no-public-law-browser-globals/no-public-law-browser-globals`.

// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals -- fixture proves direct DOM access is not SSR-safe
const viewportWidth = window.innerWidth;
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals -- fixture proves browser storage is not SSR-safe
const savedFilter = localStorage.getItem("case-law-filter");
// oxlint-disable-next-line no-public-law-browser-globals/no-public-law-browser-globals -- fixture proves media queries are browser-only
const prefersDark = matchMedia("(prefers-color-scheme: dark)").matches;

const serverRequestUrl = new URL("https://example.test/law/cases");
const serializedFilter = JSON.stringify({ court: "supreme" });

export {
  prefersDark,
  savedFilter,
  serializedFilter,
  serverRequestUrl,
  viewportWidth,
};
