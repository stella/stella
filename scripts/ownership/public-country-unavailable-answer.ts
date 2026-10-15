import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "public-country-unavailable-answer",
  capability:
    "Answering an advertised public-law country that holds no public corpus",
  owner: ["apps/api/src/lib/legal-search/public-law-country.ts"],
  summary:
    "The refusal is an answered client outcome at the contract's " +
    "`PUBLIC_COUNTRY_UNAVAILABLE_STATUS`, never a server fault. HTTP handlers " +
    "receive it only as the owner's built answer (`readPublicLawCountry`, " +
    "`publicLawCountryUnavailable`) and declare it with " +
    "`withPublicCountryUnavailable`, so no handler holds a bare body to send " +
    "under another status.",
  enforcement: {
    kind: "import",
    specifiers: ["@stll/api-contract/public-country-capability"],
    names: ["publicCountryUnavailable"],
    allowed: [
      {
        path: "apps/api/src/mcp/stella-tools.ts",
        reason:
          "MCP tools return the typed body as tool data; no HTTP status is involved.",
      },
      {
        path: "apps/api/src/mcp/legislation-tools.ts",
        reason:
          "MCP tools return the typed body as tool data; no HTTP status is involved.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
