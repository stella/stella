---
"@stll/text-normalize": minor
---

`slugify` with the `ascii` charset transliterates Latin letters instead of dropping them: accented letters lose their marks (`café` is `cafe`), and letters with no decomposition follow the `unaccent()` table (`Łódź` is `lodz`, `Straße` is `strasse`, `Æsir` is `aesir`). Keys minted earlier are not recomputed; a caller that re-derives a stored key must recognise both forms.
