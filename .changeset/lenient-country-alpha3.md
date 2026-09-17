---
"@stll/country-codes": minor
---

Add the ISO 3166-1 alpha-3 half of the standard: `COUNTRY_ALPHA3_BY_CODE`,
`COUNTRY_ALPHA3_CODES`, `countryCodeFromAlpha3` and `isCountryAlpha3Code`.
Alpha-3 is the spelling legal corpora and ELI identifiers use, so both halves
of ISO 3166-1 now come from one package. The lookups index the table by
`CountryCode`, so a code added to `COUNTRY_CODES` without an alpha-3 fails to
compile instead of resolving to undefined.
