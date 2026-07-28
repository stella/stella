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

### Restructuring around the brand: the generic-noun pattern

Declining is the failure mode this rule keeps recurring against (`ve stelle`,
`w stelli`, `a stellát`), and the naive fix is worse: a bare undeclined name in
a slot that demands a case reads as broken grammar (`Zeptat se stella`). Put a
generic noun in the case-bearing slot and leave the brand invariant beside it.
Use each locale's fixed carrier noun so the pattern reads as one habit:

| Locale | Carrier           | Example                           |
| ------ | ----------------- | --------------------------------- |
| cs     | aplikace stella   | `Provozujte aplikaci stella…`     |
| sk     | aplikácia stella  | `Prevádzkujte aplikáciu stella…`  |
| pl     | aplikacja stella  | `Uruchamiaj aplikację stella…`    |
| hu     | stella alkalmazás | `Futtassa a stella alkalmazást…`  |
| et     | rakendus stella   | `Kasuta seda rakenduses stella…`  |
| lt     | programa stella   | `Naudokite jį programoje stella…` |
| lv     | lietotne stella   | `Darbiniet lietotni stella…`      |

Locales that need no carrier (ar, de, en, es, fr, pt-BR) keep the bare brand;
Portuguese and Spanish may take the article (`a stella`, `na stella`), which is
not declension.

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

The register binds every string, body copy included; the informal locales are
where it slips, because a translator reaching for a neutral sentence lands on
the formal default (es `Lo que ve aquí` for `Lo que ves aquí`, et `mida siin
näete` for `mida siin näed`). Read a new string against the hero and the footer
of the same file before committing it.

## Legal terminology: the glossary is binding

The shared glossary (`apps/web/src/i18n/glossary.json`) defines the one
correct rendering of load-bearing product concepts per language — above all
**Matter** (ar ملف قانوني, cs Spis, sk Spis, pl Sprawa, de Akte, et Toimik,
hu Ügy, lt Byla, lv Lieta, es Asunto, fr Dossier, pt-BR Caso) — and lists
forbidden near-synonyms per language (e.g. Arabic قضية reads as "lawsuit",
German "Mandat" collides with a different concept). `i18n-lint` enforces this.

Arabic qualifies the term because bare ملف is also the everyday word for a
computer file, so Matter and Files collided; the landing carries the full
ملف قانوني wherever the concept is named, and the bare form only where the
string means a file or document.

Why: Matter names the product's central object. If the landing and the app
render it differently, users meet two products. Use the app's canonical
translation; never introduce a new synonym on the landing.

The glossary now also bans cs `případ` / sk `prípad` (nominative singular and
plural) for Matter, because a demo label had drifted to `Případy` / `Prípady`
while every other string in the same file said `spis`. Only those two forms are
banned per language: the oblique forms carry the everyday `v případě` idiom and
would false-fire.

### Terms the app owns, not the landing

For a concept that already has a rendering in `apps/web/src/i18n/langs`, the app
wins and the landing copies it, even when the landing's own wording reads
better in isolation. Verified drifts and their resolutions:

| Concept   | Locale | App term           | Landing had          |
| --------- | ------ | ------------------ | -------------------- |
| In review | cs     | `V revizi`         | `V kontrole`         |
| In review | sk     | `V revízii`        | `V kontrole`         |
| Review    | hu     | `ellenőrzés`       | `felülvizsgálat`     |
| Workspace | cs     | `pracovní prostor` | `pracovní prostředí` |
| Workspace | pl     | `obszar roboczy`   | `przestrzeń robocza` |
| Workspace | lt     | `darbo sritis`     | `darbo erdvė`        |
| Workspace | lv     | `darbvieta`        | `darba vide`         |

Hungarian is the case worth remembering: `felülvizsgálat` is not a stylistic
variant, it names the extraordinary appeal to the Kúria, so a legal reader
parses it as a procedure rather than as document review.

Any status chip, tab label, or column header the demo section reproduces is an
app string: render it verbatim, not as a fresh translation of the English.

Special case: some languages ban the literal translation of "workspace" on
matter-related strings (cs "pracovní prostor", fr "espace de travail",
et standalone "tööruum") because the app uses the Matter term where its UI
says workspace. On the landing, "workspace" as _product positioning_ (the
category the product belongs to) may translate literally; the
grandfathered entries in `i18n-lint-baseline.json` exist for exactly that
distinction: the cs and fr taglines, plus the three cs strings that carry the
identity phrase next to the word "matters" (`hero.subtitle`,
`meta.homeDescription`, `story.workspaceEyebrow`). Czech had been dodging the
ban with a second rendering of workspace; one correct term plus an honest
baseline entry beats two terms. Do not add baseline entries for any other
reason. Each entry is keyed on the (source, target) pair, so editing either
side re-checks the string.

## The identity phrase

"**open-source legal workspace**" is the product's category identity. Each
locale should settle one natural rendering of it and reuse that rendering
everywhere it appears — page titles, meta descriptions, the footer tagline,
hero copy. Consistency here is what makes the phrase recognisable to both
readers and search engines indexing the localized pages.

The settled rendering of "workspace" per locale now lives in `glossary.json`
(`nouns` → `workspace`), which bans the near-synonyms each locale had drifted
to, so the split cannot come back silently:

| Locale | Workspace         | Locale | Workspace          |
| ------ | ----------------- | ------ | ------------------ |
| ar     | مساحة عمل         | hu     | munkaterület       |
| cs     | pracovní prostor  | lt     | darbo sritis       |
| sk     | pracovný priestor | lv     | darbvieta          |
| pl     | obszar roboczy    | es     | espacio de trabajo |
| de     | Arbeitsbereich    | fr     | espace de travail  |
| et     | tööruum           | pt-BR  | espaço de trabalho |

Czech is the instructive one: `pracovní prostředí` is the Czech term for a
desktop environment, and in a legal context it reads as workplace conditions.
Latvian `darba vide` and Hungarian `munkatér` fail the same way.

Two locales cannot use their usual rendering when the string also carries the
Matter term, because the glossary forbids the literal "workspace" there
(et standalone _tööruum_, fr _espace de travail_). `hero.subtitle` therefore
uses the Estonian compound _õigustööruum_ and the French _plateforme
juridique open source_ — the renderings those locales' `meta.homeDescription`
already uses. Reach for an existing lint-safe wording before coining a new
one; a third synonym costs more than the repetition it avoids.

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

## The hero: one structure, every locale

`hero.title` is the positioning line ("Put AI to work on every matter.");
`hero.subtitle` carries the identity phrase and the product payload in one
sentence. Both render from the catalog in every locale, English included.
The homepage used to inline the English hero and reach for the catalog only
for other locales; that is precisely how the English headline got rewritten
while twelve catalogs kept the previous tagline. Source copy that lives in a
component cannot be seen to have drifted.

Do not split the identity across title and subtitle. The title sells the
outcome, the subtitle names the category; carrying "open source" in both
reads as padding in every language.

`hero.title` is an imperative in every locale, built on the verb that
language actually uses for putting a tool to productive work (cs/sk
_zapojit_, de _einsetzen_, pl _zaprzęgnąć_, lt _pasitelkti_, hu _munkába
állítani_, et _tööle panema_), never a literal gloss of "put to work". The
abbreviation for AI follows the catalog's established choice — cs, sk, hu,
lv, pl `AI`; de `KI`; es, fr, pt-BR `IA`; lt `DI`; ar الذكاء الاصطناعي — so
the hero and `home.ctaTitle` name the technology identically.

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

## Shared chrome is UI copy, not decoration

The header, the mobile menu, and the footer render on every localized page,
so their labels are catalog keys like any other string: `appearance.*` (the
theme switcher), `nav.openMenu`, `nav.github`, `footer.navLabel`. An ARIA
label counts: a screen-reader user reading the Czech page must not hear
"Toggle theme".

Chrome labels are also the strings most likely to grow in translation. The
switcher sizes to its content (`min-w-11` keeps the tap target, the width is
not fixed), because "Dark" at 44px becomes "Világos" or "Ciemny".

### Light / Dark: the app's renderings, verbatim

The switcher reuses the web app's `appearance.light` / `appearance.dark`
values unchanged. Same concept, same key path, same string on both surfaces;
a landing that says one thing and the app another is the failure this
document exists to prevent.

Every locale uses the platform-conventional **adjective** naming the mode
— the form the Windows and macOS "choose your mode" pickers use — never the
abstract noun for light or darkness. cs "Světlo", de "Licht", fr "Lumière",
ar "ضوء" are the classic machine-translation reading of a bare "Light"; they,
and their dark counterparts, are `forbidden` in `glossary.json`
(`theme-light` / `theme-dark`), so `i18n-lint` rejects them in both catalogs.

| Locale | Light   | Dark   |
| ------ | ------- | ------ |
| ar     | فاتح    | داكن   |
| cs     | Světlý  | Tmavý  |
| de     | Hell    | Dunkel |
| es     | Claro   | Oscuro |
| et     | Hele    | Tume   |
| fr     | Clair   | Sombre |
| hu     | Világos | Sötét  |
| lt     | Šviesus | Tamsus |
| lv     | Gaišs   | Tumšs  |
| pl     | Jasny   | Ciemny |
| pt-BR  | Claro   | Escuro |
| sk     | Svetlý  | Tmavý  |

The adjective agrees with the noun the locale implies for the concept
(cs/sk _režim_, pl _motyw_, lv _režīms_, lt _režimas_). That is why Lithuanian
keeps masculine "Šviesus"/"Tamsus" even though _tema_ is feminine: the picker
option describes the mode, not the theme object. Latvian uses the indefinite
"Gaišs"/"Tumšs" for the standalone option; the definite "gaišais/tumšais
režīms" belongs in running prose, not on a button.

### Verb labels follow the glossary's register

`appearance.toggle` and `nav.openMenu` are actions, so they take the same
per-locale verb form the glossary uses for Save/Close: infinitive (cs, sk, de,
lt, lv, es, fr, pt-BR), imperative (pl, et), verbal noun (hu, ar). The noun
is whatever the app calls the theme in `appearance.theme` (cs Vzhled, de
Design, lv Motīvs, ar السمة), not a second synonym coined here.

| Locale | Toggle theme     |
| ------ | ---------------- |
| ar     | تبديل السمة      |
| cs     | Přepnout vzhled  |
| de     | Design wechseln  |
| es     | Cambiar tema     |
| et     | Vaheta teemat    |
| fr     | Changer de thème |
| hu     | Téma váltása     |
| lt     | Keisti temą      |
| lv     | Mainīt motīvu    |
| pl     | Zmień motyw      |
| pt-BR  | Alternar tema    |
| sk     | Prepnúť vzhľad   |

## Typography per locale

French uses the typographic apostrophe `’` (U+2019) throughout, never the
straight `'`: the file had been mixing both. Arabic keeps its own punctuation
(see below). Nothing else in the catalogs needs locale-specific typography
today; when it does, record it here rather than fixing one string.

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
