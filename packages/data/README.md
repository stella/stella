<p align="center">
  <img src="../../.github/assets/banner.png" alt="stella anonymize" width="100%" />
</p>

# @stll/anonymize-data

Published configuration data and dictionary catalogs for `@stll/anonymize`.

This package is the stable data surface for the runtime package. It exists so the runtime can stay focused on detection logic while the published deny-list and trigger assets remain versioned separately.

## What ships

- `config/` for trigger, stopword, legal form, and coreference configuration
- `dictionaries/names/` for first names, surnames, titles, and global fallback lists
- `dictionaries/cities/` for country-specific city corpora
- `dictionaries/banks/`, `dictionaries/courts/`, `dictionaries/insurance/`, `dictionaries/education/`, `dictionaries/government/`, `dictionaries/healthcare/`, and `dictionaries/international/` for organization and institution deny-lists

## National-document field phrase coverage

These phrases belong only to their named language config; they are not global vocabulary or fallbacks for other languages.

| Language scope | Field phrase                   | Document field       |
| -------------- | ------------------------------ | -------------------- |
| Czech (`cs`)   | `rodné číslo je`               | Birth number         |
| Czech (`cs`)   | `číslo občanského průkazu je`  | Identity card number |
| German (`de`)  | `Personalausweisnummer lautet` | Identity card number |
| English (`en`) | `passport number is`           | Passport number      |

## Install

```bash
bun add @stll/anonymize-data
```

## Usage

```ts
import triggers from "@stll/anonymize-data/config/triggers.cs.json";
import cities from "@stll/anonymize-data/dictionaries/cities/CZ.json";
import banks from "@stll/anonymize-data/dictionaries/banks/US.json";
```

The lazy loaders are split across two module entries:

```ts
// Deny-list catalog, name dictionaries, single-dictionary loaders.
import { loadDictionary, loadNameDictionaries } from "@stll/anonymize-data";
// City dictionaries and the full bundle.
import {
  loadCityDictionary,
  loadDictionaryBundle,
} from "@stll/anonymize-data/cities";
```

The city API sits in its own entry because its loader map holds one literal `import()` per covered country. A bundler emits every city chunk for any module graph that reaches it, so the root entry stays free of that dependency.

## Maintenance

- The package build checks trigger configs for schema mistakes and duplicate trigger collisions.
- The npm tarball is expected to contain every exported dictionary path listed in `package.json`.
- Release automation should validate the packed file list before anything is published.
