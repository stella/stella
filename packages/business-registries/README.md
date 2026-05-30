# @stll/business-registries

Typed clients for national business and commercial registries.

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

## Supported registries

| Subpath | Jurisdiction   | Registry                                      |
| ------- | -------------- | --------------------------------------------- |
| `/ares` | Czech Republic | [ARES](https://ares.gov.cz) — public open API |

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

Live integration tests live in `*.test.ts` files guarded by
`SMOKE_TEST=1` so the unit suite stays offline-safe.

## License

Apache-2.0
