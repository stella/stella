<p align="center">
  <img src=".github/assets/banner.png" alt="stll/boe" width="100%" />
</p>

# @stll/boe

A typed client for Spain's official BOE open-data APIs.

Use it to search consolidated Spanish legislation, fetch law metadata and
structure, retrieve text blocks, and inspect BORME daily summaries without
hand-building BOE query strings.

## Why This Exists

The BOE API is rich, but its useful data is spread across search endpoints,
metadata sections, XML text payloads, ELI metadata, and BORME summary trees.
`@stll/boe` keeps that access boring: typed functions, validation at the edge,
timeouts, and structured errors.

## Install

```sh
bun add @stll/boe
```

## Example

```ts
import { getConsolidatedLaw, searchConsolidatedLegislation } from "@stll/boe";

const results = await searchConsolidatedLegislation({
  title: "Código Civil",
  dateFrom: "18890101",
  limit: 10,
});

const law = await getConsolidatedLaw("BOE-A-1889-4763", {
  fullText: true,
  metadata: true,
});

console.log(results.data?.[0]?.titulo);
console.log(law.fullText);
```

## What Is Covered

- Consolidated legislation search.
- Single-law metadata, analysis, text, ELI metadata, and structure.
- Individual law text blocks.
- Related-law lookup.
- BOE and BORME daily summaries.
- Typed BOE request, validation, not-found, and API errors.

## License

Apache-2.0
