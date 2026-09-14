---
"@stll/business-registries": minor
---

Add the punctuated identifier forms each jurisdiction writes into a company specification, for registries whose upstream returns the identifier unpunctuated: `[registry number spaced]` for the Slovak IČO ("31 322 832", grouped `dd ddd ddd`, two digits ahead of the Czech `ddd dd ddd`) and the Norwegian organisasjonsnummer ("923 609 016"), `[SIREN spaced]` ("552 081 317") and `[SIRET spaced]` ("552 081 317 00018") for France, and `[EIN dashed]` ("94-2404110") for EDGAR. Slovakia also gains `[court genitive]` ("Obchodný register Mestského súdu Bratislava III") over the eight registry courts left standing by the 2023 court map.

Every helper is pure, passes malformed or already-punctuated input through untouched, and is therefore idempotent. Built-in default formats are unchanged; the new tokens are offered to authors alongside the raw ones.
