<p align="center">
  <img src="https://raw.githubusercontent.com/stella/stella/main/.github/assets/banners/country-codes.webp" alt="stll/country-codes" width="100%" />
</p>

# @stll/country-codes

The canonical ISO 3166-1 country code list used across the stella monorepo, in
both alpha-2 and alpha-3, with a derived TypeScript literal-union type so
country codes can be branded at compile time rather than passed around as bare
strings.

```ts
import {
  COUNTRY_CODES,
  type CountryCode,
  isCountryCode,
} from "@stll/country-codes";

// `CountryCode` is a literal union of every code in `COUNTRY_CODES`:
const cz: CountryCode = "CZ"; // ok
const oops: CountryCode = "ZZ"; // type error

// Narrow untrusted input at the boundary:
const raw: string = userInput;
if (isCountryCode(raw)) {
  // `raw` is `CountryCode` here
}
```

The list is a frozen `as const` tuple, so adding or removing a code
in `codes.ts` immediately changes the union and any callsite that
constructs `CountryCode` values gets a typecheck signal.

Alpha-3 is the spelling legal corpora and ELI identifiers use, so both halves of
the standard live here rather than in whichever consumer needed the other half
first:

```ts
import {
  COUNTRY_ALPHA3_BY_CODE,
  countryCodeFromAlpha3,
} from "@stll/country-codes";

COUNTRY_ALPHA3_BY_CODE.CZ; // "CZE"
countryCodeFromAlpha3("SVK"); // "SK"
```

The table is a plain `as const`, so the published declaration stays inferable
from the literal, and the lookups above index it by `CountryCode`: a code added
to `COUNTRY_CODES` without an alpha-3 fails to compile there instead of leaving
the two halves to drift.

Includes `XK` (Kosovo), which is widely used (EU, IMF, World Bank,
CLDR) despite not yet being officially ISO-assigned.

## License

Apache-2.0
