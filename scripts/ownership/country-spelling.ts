import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "country-spelling",
  capability:
    "Resolving a country a caller spelled its own way to its canonical ISO code",
  owner: ["packages/agent-input/src/"],
  summary:
    "A country decides which body of law a call searches, so reading one " +
    "wrong is a wrong answer rather than a formatting defect. One reader " +
    "maps every spelling that carries a single meaning — alpha-3, alpha-2, " +
    "and the country's CLDR name in each language the corpus serves — onto " +
    "one canonical code, and asks with both readings named when a spelling " +
    "carries two. The alpha-3 half of ISO 3166-1 is what a second reader " +
    "would need, so the rule below confines it: `COUNTRY_CODES` and " +
    "`isCountryCode` stay open for the surfaces that hold an alpha-2 " +
    "column, while the alpha-3 table and its lookups reach only the owner. " +
    "Two lenient readers of one kind are worse than one strict reader, " +
    "because they disagree about which country a name names.",
  enforcement: {
    kind: "import",
    // Both spellings of one module: the package entry point, and the file
    // that defines the table as a repository path. Relative imports resolve
    // to that path, so `@stll/country-codes` alone would leave a deep
    // relative import of the source file unconfined.
    specifiers: ["@stll/country-codes", "packages/country-codes/src/alpha3.ts"],
    names: [
      "COUNTRY_ALPHA3_BY_CODE",
      "COUNTRY_ALPHA3_CODES",
      "countryCodeFromAlpha3",
      "isCountryAlpha3Code",
    ],
    allowed: [
      {
        path: "packages/country-codes/src/index.ts",
        reason:
          "The package entry point re-exports the table it defines; readers stay confined at the package specifier.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
