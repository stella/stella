<p align="center">
  <img src="https://raw.githubusercontent.com/stella/stella/main/.github/assets/banners/business-registries.webp" alt="stll/business-registries" width="100%" />
</p>

# @stll/business-registries

Typed clients for national business and commercial registries.

Find companies, normalize registry identifiers, and reuse public business data
without writing a different scraper for every jurisdiction.

Each jurisdiction lives in its own subpath so consumers import only what they
need:

```ts
import { lookupByIco } from "@stll/business-registries/ares";

const company = await lookupByIco("27082440");
```

A namespace re-export is also available from the root entry:

```ts
import { ares } from "@stll/business-registries";

await ares.lookupByIco("27082440");
```

Browser applications initialize the validation runtime once during startup. Calls
are safe to share when several features initialize concurrently:

```ts
import { initialize } from "@stll/business-registries/browser";

await initialize();
```

Registry identifier validators stay synchronous after initialization. Calling one
before the runtime is ready throws `StdnumNotInitializedError`, also exported from
the `/browser` subpath.

## Supported registries

| Subpath   | Jurisdiction   | Registry                                                                                                                      |
| --------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `/ares`   | Czech Republic | [ARES](https://ares.gov.cz) — public open API                                                                                 |
| `/brreg`  | Norway         | [Brønnøysundregistrene](https://data.brreg.no/enhetsregisteret/api/docs/index.html) — public open API                         |
| `/denue`  | Mexico         | [INEGI DENUE](https://www.inegi.org.mx/servicios/api_denue.html) — official establishment / economic-unit API; token required |
| `/sudreg` | Croatia        | [Sudski registar](https://sudreg.pravosudje.hr) — public company lookup                                                       |
| `/zefix`  | Switzerland    | [Zefix](https://www.zefix.ch) — public commercial-register search API                                                         |

More jurisdictions land per-PR; see the package README on the main branch for
the current list.

## Design notes

Every registry client follows the same contract:

- A `lookupBy<Id>(id, options?)` function that returns the parsed domain entity
  or `null` when the identifier is not found.
- A `searchByName(name, options?)` function that returns a flat list of results.
- Tagged errors (`<Registry>APIError`, `<Registry>ValidationError`,
  `<Registry>RequestError`, `<Registry>TooBroadError`) so callers can branch on
  failure mode.
- Pure parsers exposed alongside the client so consumers can ingest cached or
  mocked raw payloads without hitting the network.

Adapters also export `toNormalizedEntity` and `toNormalizedSearchResult`
projections where a domain model is available. Each optional normalized field is
a discriminated value: it contains data when available, or records that the field
was not loaded or is not supported by that adapter. These states cannot overlap.

Tests use captured fixtures and mocked HTTP responses so the suite stays
deterministic and offline-safe.

## License

Apache-2.0
