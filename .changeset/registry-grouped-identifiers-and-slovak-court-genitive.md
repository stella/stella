---
"@stll/business-registries": minor
---

Rewrite the built-in default of every company-specification registry into the party-identification clause a local lawyer actually writes, and add the punctuated identifier tokens those clauses need.

New tokens, for registries whose upstream returns the identifier unpunctuated: `[registry number spaced]` for the Slovak IČO ("31 322 832", grouped `dd ddd ddd`, two digits ahead of the Czech `ddd dd ddd`) and the Norwegian organisasjonsnummer ("923 609 016"); `[SIREN spaced]` and `[SIRET spaced]` for France; `[EIN dashed]` for EDGAR. Slovakia also gains `[court genitive]` over the eight registry courts the 2023 court map left standing, plus `[section]` and `[insert]`.

New defaults: Slovak cites the register the way the register does ("zapísaná v Obchodnom registri Mestského súdu Bratislava III, oddiel: Sro, vložka č. 3586/B"); Polish identifies the KRS number without claiming a sub-register; French names the siège social and SIREN number without inferring RCS registration; UK preserves the recorded legal form, including partnerships; Norwegian and Finnish follow local party-clause form. A default is now declared as a list of clauses, each naming the particulars it needs, and both the author-facing string and the built-in rendering are derived from that one list, so a record missing a particular drops the whole clause instead of leaving a dangling label. Every retired default is registered in `PREVIOUS_DEFAULT_FORMATS`, so a saved copy keeps rendering as the built-in.

Two fixes fall out of the same work: the Slovak file reference is cited in the register's own order ("Sro 3586/B", not "B, Sro 3586"), and a KRS REGON that the API right-pads to fourteen characters is unpadded back to the nine-digit number that exists.
