---
"@stll/business-registries": minor
---

Add the genitive court form (`[court genitive]`, "u Městského soudu v Praze") and a grouped identifier (`[registry number spaced]`, "270 82 440") to the ARES company specification tokens. The built-in ARES format now renders the grouped identifier and starts with the company name, without the "společnost" prefix. Saved copies of the previous built-in string keep behaving as the built-in: `isBuiltInRegistryFormat` recognizes previously shipped defaults alongside the current one.
