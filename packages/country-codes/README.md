<p align="center">
  <img src=".github/assets/banner.png" alt="stll/country-codes" width="100%" />
</p>

# @stll/country-codes

The canonical ISO 3166-1 alpha-2 country code list used across the stella
monorepo, with a derived TypeScript literal-union type so country codes can
be branded at compile time rather than passed around as bare strings.

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

Includes `XK` (Kosovo), which is widely used (EU, IMF, World Bank,
CLDR) despite not yet being officially ISO-assigned.

## License

Apache-2.0
