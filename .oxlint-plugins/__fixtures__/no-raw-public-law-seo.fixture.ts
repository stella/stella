// Passive regression fixture for `no-raw-public-law-seo/no-raw-public-law-seo`.

// oxlint-disable-next-line no-raw-public-law-seo/no-raw-public-law-seo -- fixture proves raw canonical metadata keys are rejected
const rawCanonical = "canonical";
// oxlint-disable-next-line no-raw-public-law-seo/no-raw-public-law-seo -- fixture proves Open Graph template tokens are rejected
const rawOpenGraph = `og:title`;
// oxlint-disable-next-line no-raw-public-law-seo/no-raw-public-law-seo -- fixture proves Twitter metadata prefixes are rejected
const rawTwitter = "twitter:card";

const routeTitle = "Supreme Court decisions";
const metadata = createPublicLawHead();

declare function createPublicLawHead(): Record<string, unknown>;

export { metadata, rawCanonical, rawOpenGraph, rawTwitter, routeTitle };
