# Landing translation guidelines

How and why the landing catalogs (`messages/*.json`) are translated the way
they are. The checks in `bun run i18n:check` enforce most of this; this
document explains the intent behind the rules so future translations stay
coherent rather than merely passing.

## Source language

- The source is **British English** (`-ise`, `-our`). Established product
  names keep their canonical spelling regardless (e.g. `Anonymization`).
- The brand is written **`stella`, lowercase, always** — including at the
  start of a sentence and in every locale. It is never translated,
  transliterated, or declined; in languages that decline nouns, restructure
  around it (e.g. Latvian `lietotnē stella`, not a declined brand).

## Translate meaning, not words

Marketing copy is translated for effect, not word-by-word. A punchy English
triplet ("Your matters. Your stack. Your terms.") needs an equally punchy
native triplet, not a literal gloss. When an English pun cannot carry over
("work that matters"), translate the meaning and drop the pun.

## Register per locale

Each catalog has an established register. Stay consistent **within the
file** — check the existing hero/footer strings before adding keys:

| Locale | Register                               |
| ------ | -------------------------------------- |
| ar     | Modern Standard Arabic, direct address |
| cs     | vykání (formal you)                    |
| de     | Sie                                    |
| es     | tú                                     |
| et     | sina (informal)                        |
| fr     | vous                                   |
| hu     | Ön                                     |
| lt     | Jūs                                    |
| lv     | Jūs                                    |
| pl     | informal ty, capitalised Twoje/Twoja   |
| pt-BR  | você                                   |
| sk     | vykanie (formal you)                   |

## Legal terminology: the glossary is binding

The shared glossary (`apps/web/src/i18n/glossary.json`) defines the one
correct rendering of load-bearing product concepts per language — above all
**Matter** (ar ملف, cs Spis, sk Spis, pl Sprawa, de Akte, et Toimik, hu Ügy,
lt Byla, lv Lieta, es Asunto, fr Dossier, pt-BR Caso) — and lists forbidden
near-synonyms per language (e.g. Arabic قضية reads as "lawsuit", German
"Mandat" collides with a different concept). `i18n-lint` enforces this.

Why: Matter names the product's central object. If the landing and the app
render it differently, users meet two products. Use the app's canonical
translation; never introduce a new synonym on the landing.

Special case: some languages ban the literal translation of "workspace" on
matter-related strings (cs "pracovní prostor", fr "espace de travail",
et standalone "tööruum") because the app uses the Matter term where its UI
says workspace. On the landing, "workspace" as _product positioning_ (the
category the product belongs to) may translate literally; the two
grandfathered tagline entries in `i18n-lint-baseline.json` exist for exactly
that distinction. Do not add new baseline entries without the same
justification.

## The identity phrase

"**open-source legal workspace**" is the product's category identity. Each
locale should settle one natural rendering of it and reuse that rendering
everywhere it appears — page titles, meta descriptions, the footer tagline,
hero copy. Consistency here is what makes the phrase recognisable to both
readers and search engines indexing the localized pages.

### "open source" per locale

The term itself is rendered per locale by whichever form that language's
technical audience dominantly uses — the English loanword where the
loanword is the standard term, the native compound where the native term
is. Fixed choices (use these, never a synonym):

| Locale | Rendering                                    |
| ------ | -------------------------------------------- |
| ar     | مفتوح المصدر (agree in gender with the noun) |
| cs     | open source (loanword)                       |
| de     | Open Source / Open-Source- in compounds      |
| es     | código abierto                               |
| et     | avatud lähtekoodiga                          |
| fr     | open source (loanword)                       |
| hu     | nyílt forráskódú                             |
| lt     | atvirojo kodo                                |
| lv     | atvērtā pirmkoda                             |
| pl     | open source (loanword)                       |
| pt-BR  | código aberto                                |
| sk     | open source (loanword)                       |

Why not one global rule: "Open Source" is the recognised standard in
German and the Slavic tech vocabularies, while Spanish, Portuguese, and
Arabic have fully dominant native terms; forcing either direction
everywhere reads foreign in half the markets. A plain "open/otevřené/
otwarte" adjective is NOT a substitute for the technical term in the
identity phrase.

## Hero structure differs by locale

The English hero carries the identity in its subtitle. The non-English
heroes already carry it in their **title lines** ("Legal workspace. / Open
Source." equivalents). Their subtitles must therefore carry the product
payload (the product nouns, the citations claim) **without repeating the
identity** — duplicating "open source" in title and subtitle reads as
padding in every language.

## Meta strings are length-budgeted

`meta.homeTitle` ≤ ~60 characters, `meta.homeDescription` ~140–160
characters. Search results truncate beyond that; a beautifully translated
description that gets cut mid-clause is a worse outcome than a tighter one.
Keep the brand verbatim and the identity phrase intact inside the budget.

## Cognates are allowed — deliberately

When the natural term in a language _is_ the English word (Status, Editor,
Blog, Beta), keep it. Do not invent a forced native alternative to avoid
matching the source. Such entries are recorded in
`i18n-check-baseline.json` so the untranslated-string check accepts them;
extend the baseline only for genuine cognates.

## Product names on marketing surfaces

Navigation, the mega-menu, and the hero scene's discover tags use the
English product eyebrows (Workspace, Editor, Tabular Review, CLI & MCP) as
brand-constant labels. The footer's product column uses localized
descriptors (existing `footer.*` keys). Follow whichever pattern the
surface already uses; do not translate a product name in one menu and not
another.

## Arabic specifics

Use native punctuation (، ؛) in running prose. Direction is handled by the
layout (`dir` attribute from locale config) — never embed directional
control characters in strings. Follow the glossary's Arabic notes exactly;
several near-synonyms are explicitly forbidden.

## Mechanics

- Keys are typed: components reference catalogs through `TranslationKey`,
  so a missing or renamed key fails typecheck. Never inline a
  language-specific string in a component.
- After editing catalogs: `bun run i18n:sync` (sorts + regenerates types),
  then `bun run i18n:check` must exit 0.
- One concept, one translation: before adding a key, check whether an
  existing key already carries the string (`common.*`, `footer.*`) and
  reuse it.
