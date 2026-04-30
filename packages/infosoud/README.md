# @stll/infosoud

TypeScript SDK and Bun-first CLI for the public
[InfoSoud](https://infosoud.gov.cz) endpoints used for Czech court case lookup.

The package name is `@stll/infosoud`; the CLI binary remains `infosoud`.

It is meant to be the boring, reusable layer:

- parse and normalize `spisová značka` input
- resolve court codes from fuzzy court-name queries
- fetch case details, hearings, and event details
- ship a checked-in catalog of observed event and attribute codes from the public
  frontend bundle
- expose typed errors instead of leaking raw upstream responses

## Install

```sh
bun add @stll/infosoud
```

## CLI

```sh
# Search a case
infosoud "1 T 64/2024" OSSCEDC
infosoud "1T64_2024 OSSCEDC"
infosoud "4 T 21/2025 melnik"

# Hearings only
infosoud --hearings "1 T 64/2024" OSSCEDC

# Structured output
infosoud --json "1 T 64/2024" OSSCEDC
infosoud --csv "1 T 64/2024" OSSCEDC

# Courts
infosoud --courts
infosoud --courts --json
```

## SDK

```ts
import {
  InfoSoudClient,
  formatSpisZnCanonical,
  parseSpisZn,
} from "@stll/infosoud";

const client = new InfoSoudClient();

const parsed = parseSpisZn("1T64_2024 OSSCEDC");
console.log(formatSpisZnCanonical(parsed));

const result = await client.searchCase({
  courtCode: "OSSCEDC",
  spisZn: "1 T 64/2024",
});

console.log(result.organizace);
console.log(result.udalosti.length);
```

## Richer Event Details

`searchCaseWithDetails()` hydrates selected case events with `/udalost/vyhledej`
data, adds pre-parsed hearing metadata for the common hearing event types, and
attaches human labels from the bundled InfoSoud code catalog.

```ts
import {
  getEventAttribute,
  InfoSoudAPIError,
  InfoSoudClient,
} from "@stll/infosoud";

const client = new InfoSoudClient();

const result = await client.searchCaseWithDetails({
  courtCode: "OSSCEDC",
  spisZn: "1 T 64/2024",
});

for (const event of result.udalosti) {
  if (!event.detail) {
    continue;
  }

  console.log(event.detailTypeLabel, event.hearingDetail?.startsAt);
  console.log(event.detailAttributeEntries[0]?.label);
  console.log(getEventAttribute(event.detail, "JED_SIN"));
  console.log(event.decodedDetail?.kind);
}

try {
  await client.getCaseEventDetail({
    courtCode: "OSSCEDC",
    event: result.udalosti[0],
    spisZn: "1 T 64/2024",
  });
} catch (error) {
  if (error instanceof InfoSoudAPIError && error.status === 400) {
    console.log("InfoSoud has no detail payload for that event");
  }
}
```

By default, only `NAR_JED` and `ZRUS_JED` events are hydrated. Override that with
`includeEventTypes`.

The decoded layer currently understands:

- hearings: `NAR_JED`, `ZRUS_JED`
- decisions: `VYD_ROZH`
- appeal submission and disposition: `POD_OP_PR`, `VYR_OP_PR`
- file transfer and case transfer: `ODES_SPIS`, `VRAC_SPIS`, `PREVD_SPIS`
- status events: `ST_VEC_*`

Unknown event families are still preserved as raw detail and surfaced as
`decodedDetail.kind === "unknown"`.

## Bundled Code Catalog

The package now ships a checked-in event and attribute code catalog extracted from
the public InfoSoud frontend bundle. It is useful for:

- labeling raw `typUdalosti` codes
- labeling `atributy[].typ` codes
- exposing upstream tooltip/description text for known event families
- detecting when upstream introduces new codes outside the known catalog

Example:

```ts
import {
  collectUnknownInfoSoudCodes,
  getEventDescription,
  getEventTooltip,
} from "@stll/infosoud";

console.log(getEventTooltip("NAR_JED"));
console.log(getEventDescription("VYD_ROZH"));

const unknownCodes = collectUnknownInfoSoudCodes({
  details: result.udalosti.flatMap((event) =>
    event.detail ? [event.detail] : [],
  ),
  events: result.udalosti,
});
```

Refresh the catalog from the live site:

```sh
cd packages/infosoud
bun run extract:codes
```

Verify that the checked-in catalog is current:

```sh
cd packages/infosoud
bun run extract:codes:check
```

## Timeline Helpers

The package also exposes higher-level selectors over case timelines:

- `getNextHearingCaseEvent(events)`
- `getLatestDecisionCaseEvent(events)`
- `getLatestMaterialCaseEvent(events)`
- `isMaterialCaseEvent(event)`

These work with either plain case events or enriched events from
`searchCaseWithDetails()`. If enriched detail is available, hearing and decision
helpers prefer the parsed temporal values from the decoded detail payload.

## Caching

The client caches successful responses in memory by default:

- case lookups: 6 hours
- hearings: 1 hour
- event details: 6 hours
- courts and derived court map: 24 hours

Disable caching entirely:

```ts
const client = new InfoSoudClient({ cache: false });
```

Tune cache TTLs:

```ts
const client = new InfoSoudClient({
  cache: {
    caseTtlMs: 30 * 60 * 1000,
    hearingsTtlMs: 5 * 60 * 1000,
  },
});
```

Clear the cache explicitly:

```ts
client.clearCache();
```

## Court Resolution

Court-name lookup is diacritics-insensitive and handles common shorthand such as:

- `melnik`
- `OS Decin`
- `decin os`
- `praha 9`
- `ms praha`

Ambiguous Prague district lookups (`OSPHA`) are resolved by probing
`OSPHA01` through `OSPHA10`.

## Errors

The client throws typed errors:

- `InfoSoudAPIError`: upstream returned a non-2xx response
- `InfoSoudParseError`: upstream payload shape did not match expectations
- `InfoSoudRequestError`: network, timeout, or transport failure

## Covered Endpoints

- `/api/v1/rizeni/vyhledej`
- `/api/v1/jednani/vyhledej`
- `/api/v1/udalost/vyhledej`
- `/api/v1/organizace/lov`
- `/api/v1/organizace/podrizene/lov`

## Releasing

Package-local release steps live in [PUBLISHING.md](./PUBLISHING.md). For a dry run:

```sh
cd packages/infosoud
bun run release:check
```
