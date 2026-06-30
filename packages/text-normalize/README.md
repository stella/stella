# @stll/text-normalize

Search match-key text normalization. Folds orthographic variants so a
search query matches text regardless of how it was typed.

The normalized output is a **match key**: it is lossy and intended only
for indexing and query comparison. Never store or display it in place of
the original text.

## Arabic

`normalizeSearchText` folds the orthographic variants that make Arabic
search miss otherwise-identical words:

- alef variants and alef-wasla (`أ إ آ ٱ`) to bare alef `ا`
- waw-hamza `ؤ` to `و`, yeh-hamza `ئ` to `ي`, standalone hamza `ء` dropped
- teh marbuta `ة` to heh `ه`
- alef maksura `ى` to yeh `ي`
- tashkeel (harakat), superscript alef, and tatweel removed
- Arabic-Indic and Extended Arabic-Indic digits to ASCII

It also runs NFKC (folding presentation forms), locale-stable ASCII case
folding, and whitespace collapse, so it is a safe pass-through for
non-Arabic scripts.

The fold tables are vendored from Lucene's `ArabicNormalizer` (Apache-2.0)
and cross-checked against CAMeL Tools (MIT), extended for the classes
Lucene omits.

```ts
import { normalizeSearchText } from "@stll/text-normalize";

normalizeSearchText("أحمد") === normalizeSearchText("احمد"); // true
```

The same fold must be reproduced by the PostgreSQL `arabic_normalize()`
function used in contacts trigram expression indexes and search predicates;
the golden vectors in `src/normalize.test.ts` pin the shared contract.
