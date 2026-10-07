// API code the treemap browser check needs. The spec loads it as one ES
// module bundle: apps/api is not an ES module package, and Playwright would
// otherwise load these sources as CommonJS, which cannot import their
// ES-module-only dependencies.
export { courtTierLabelsForLanguage } from "@stll/api-contract/case-law-court-tier-locales";

export { treemapFixture } from "../src/handlers/visual-sandbox/browser/treemap-fixture";
export { sanitizeVisualHtml } from "../src/handlers/visual-sandbox/sanitize";
export {
  composeVisualDocument,
  escapeVisualJson,
} from "../src/handlers/visual-sandbox/srcdoc";
