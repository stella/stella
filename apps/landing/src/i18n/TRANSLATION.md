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

Product names are **descriptors, not brand marks**: only `stella` is the
brand. Every localized surface therefore names a product in the reader's
language. The product eyebrows (Workspace, Editor, Templates, Tabular Review,
AI agent, Anonymization, Public data, CLI & MCP) render from
`nav.products.<slug>.eyebrow` in the mega-menu and the mobile menu, and from
the `footer.*` descriptors in the footer's product column. This reverses an
earlier rule that treated the eyebrows as brand-constant English: a Czech page
whose footer said "Tabulková revize" while the menu above it said "Tabular
Review" was naming the same page twice, as two products.

The `/product/<slug>` pages are English-only and keep rendering the registry's
own `eyebrow` from `data/products/*.ts`; that field stays the English source
of truth, and `menu-copy.test.ts` asserts `en.json` agrees with it, the same
drift guard the menu `title`/`blurb` already have.

| Locale | Workspace          | Editor      | Templates | Tabular Review        | AI agent              | Anonymization | Public data       |
| ------ | ------------------ | ----------- | --------- | --------------------- | --------------------- | ------------- | ----------------- |
| ar     | مساحة العمل        | المحرر      | القوالب   | المراجعة الجدولية     | وكيل الذكاء الاصطناعي | إخفاء الهوية  | البيانات العامة   |
| cs     | Pracovní prostor   | Editor      | Vzory     | Tabulková revize      | AI agent              | Anonymizace   | Veřejná data      |
| de     | Arbeitsbereich     | Editor      | Vorlagen  | Tabellenprüfung       | KI-Agent              | Anonymisierung | Öffentliche Daten |
| es     | Espacio de trabajo | Editor      | Plantillas | Revisión tabular      | Agente de IA          | Anonimización | Datos públicos    |
| et     | Tööruum            | Redaktor    | Mallid    | Tabelülevaatus        | Tehisintellekti agent | Anonüümimine  | Avalikud andmed   |
| fr     | Espace de travail  | Éditeur     | Modèles   | Revue tabulaire       | Agent IA              | Anonymisation | Données publiques |
| hu     | Munkaterület       | Szerkesztő  | Sablonok  | Táblázatos ellenőrzés | AI-ügynök             | Anonimizálás  | Nyilvános adatok  |
| lt     | Darbo sritis       | Redaktorius | Šablonai  | Lentelinė peržiūra    | DI agentas            | Anonimizavimas | Viešieji duomenys |
| lv     | Darbvieta          | Redaktors   | Veidnes   | Tabulāra pārskatīšana | AI aģents             | Anonimizācija | Publiskie dati    |
| pl     | Obszar roboczy     | Edytor      | Szablony  | Przegląd tabelaryczny | Agent AI              | Anonimizacja  | Dane publiczne    |
| pt-BR  | Espaço de trabalho | Editor      | Modelos   | Revisão tabular       | Agente de IA          | Anonimização  | Dados públicos    |
| sk     | Pracovný priestor  | Editor      | Vzory     | Tabuľková revízia     | AI agent              | Anonymizácia  | Verejné dáta      |

No cell in that table is a new translation. Each one is the `footer.*`
descriptor the same locale already used for the same product page, copied
across so the two surfaces cannot drift: one concept, one translation. When a
new product page lands, take its eyebrow from its footer descriptor rather
than translating the English afresh.

`CLI & MCP` is the one eyebrow that stays English in all twelve locales: both
halves are protocol names, not words. It is recorded per-locale under
`identicalToSource` in `i18n-check-baseline.json`, the same way other genuine
cognates are.

The hero scene's discover chips follow the same rule. `CliMcpPreview` is a
React island with no translator, so `HomePage.astro` resolves every eyebrow for
the active locale (`resolveProductEyebrows` in `data/site-nav.ts`) and passes
the names in beside the "Discover" verb, as one `discover` prop: a caller
cannot supply a translated verb and leave the product name English. The chips
read "Objevte Pracovní prostor" on `/cs/`, "Entdecken Sie Arbeitsbereich" on
`/de/`. An island that needs a product name takes it that way; do not hardcode
one in a `.tsx` file.

Because the eyebrows repeat the footer descriptors, six of them share an
en.json value with their `footer.*` twin and are listed under `duplicateValues`
in `i18n-check-baseline.json` (`agent`, `anonymization`, `editor`,
`public-data`, `templates`, `workspace`). Hoisting a product name to `common.*`
to serve a menu and a footer would make one key own two surfaces with different
length budgets; the duplication is the cheaper honest option.
`tabular-review` needs no entry: the eyebrow is title-cased (_Tabular Review_)
and `footer.tabularReview` is not, so the two English values differ.

### Pillar group labels DO translate

The mega-menu's three group headings (`nav.pillars.data`,
`nav.pillars.intelligence`, `nav.pillars.workspace`, keyed on the pillar ids in
`data/products/pillars.ts`) name categories, not products, so they translate in
every locale too.

| Locale | Data infrastructure       | Legal intelligence     | Workspace          |
| ------ | ------------------------- | ---------------------- | ------------------ |
| ar     | البنية التحتية للبيانات   | الذكاء القانوني        | مساحة عمل          |
| cs     | Datová infrastruktura     | Právní analytika       | Pracovní prostor   |
| de     | Dateninfrastruktur        | Juristische Analytik   | Arbeitsbereich     |
| es     | Infraestructura de datos  | Inteligencia jurídica  | Espacio de trabajo |
| et     | Andmetaristu              | Õigusanalüütika        | Tööruum            |
| fr     | Infrastructure de données | Intelligence juridique | Espace de travail  |
| hu     | Adatinfrastruktúra        | Jogi analitika         | Munkaterület       |
| lt     | Duomenų infrastruktūra    | Teisinė analitika      | Darbo sritis       |
| lv     | Datu infrastruktūra       | Juridiskā analītika    | Darbvieta          |
| pl     | Infrastruktura danych     | Analityka prawna       | Obszar roboczy     |
| pt-BR  | Infraestrutura de dados   | Inteligência jurídica  | Espaço de trabalho |
| sk     | Dátová infraštruktúra     | Právna analytika       | Pracovný priestor  |

"Legal intelligence" is the label that does not travel as one word. Two
families, chosen by what each language's legal-tech market actually calls the
function:

- Romance locales and Arabic keep the cognate, which is an established term
  there for the analytic layer over legal material: fr _intelligence
  juridique_, es _inteligencia jurídica_, pt-BR _inteligência jurídica_,
  ar الذكاء القانوني.
- Germanic, Slavic, Baltic, and Finno-Ugric locales take the analytics family
  instead, because a literal "intelligence" reads there as either the human
  faculty or as espionage (cs _právní inteligence_, de _Rechtsintelligenz_ are
  both wrong readings, not stylistic variants). German _juristische Analytik_,
  cs _právní analytika_ / sk _právna analytika_, pl _analityka prawna_, hu
  _jogi analitika_, et _õigusanalüütika_, lt _teisinė analitika_, lv _juridiskā
  analītika_ are the renderings that market uses for legal analytics.

"Workspace" reuses the settled rendering from `glossary.json` (the table above
under _The identity phrase_) rather than coining a menu-only variant. That
makes `nav.pillars.workspace` hold the same string as `footer.workspace` and
`nav.products.workspace.eyebrow` in every locale, which is deliberate: the
pillar names the category, the other two name the product page, and all three
are one word in English. The keys are listed in `i18n-check-baseline.json`
under `duplicateValues` for that reason (same precedent as `demo.status` /
`footer.status`); hoisting one word to `common.*` to serve three unrelated
surfaces would be worse.

The visible consequence is that the workspace pillar's group label and its
first entry are the same word, stacked: _PRACOVNÍ PROSTOR_ over _Pracovní
prostor_, _ARBEITSBEREICH_ over _Arbeitsbereich_. That is the English menu's
own reading (_WORKSPACE_ over _Workspace_), not a translation artefact, and the
two rows are already distinguished the way English distinguishes them: the
group label is uppercased, 0.625rem, letter-spaced, and muted, the entry is
0.875rem in the foreground colour. Do not coin a second workspace term to
break the repetition; the near-synonyms are exactly what `glossary.json` bans.
Arabic is the one locale where the pair differs by itself, because the pillar
takes the indefinite مساحة عمل and the product entry the definite مساحة العمل.

Estonian uses _taristu_, the standard Estonian term for infrastructure, so the
data pillar is _Andmetaristu_ rather than the loan compound
_andmeinfrastruktuur_.

## Shared chrome is UI copy, not decoration

The header, the mobile menu, and the footer render on every localized page,
so their labels are catalog keys like any other string: `appearance.*` (the
theme switcher), `nav.openMenu`, `nav.github`, `footer.navLabel`. An ARIA
label counts: a screen-reader user reading the Czech page must not hear
"Toggle theme".

Chrome labels are also the strings most likely to grow in translation. The
switcher sizes to its content (`min-w-11` keeps the tap target, the width is
not fixed), because "Dark" at 44px becomes "Világos" or "Ciemny".

### The hero scene's window handles

The three draggable windows in `CliMcpPreview` are focus controls, so their
handles carry an accessible name: `story.bringWorkspaceToFront`,
`story.bringEditorToFront`, `story.bringTerminalToFront`. The island has no
translator, so every Astro mount passes `windowLabels`
(`resolveSceneWindowLabels` in `data/product-story.ts`) and the prop is
required — an optional prop with an English default is the same bug written
more politely.

| Locale | Bring stella workspace to front                         |
| ------ | ------------------------------------------------------- |
| ar     | إحضار مساحة عمل stella إلى المقدمة                      |
| cs     | Přenést do popředí pracovní prostor aplikace stella      |
| de     | Arbeitsbereich von stella in den Vordergrund holen       |
| es     | Traer al frente el espacio de trabajo de stella          |
| et     | Too rakenduse stella tööruum esiplaanile                 |
| fr     | Mettre l’espace de travail stella au premier plan        |
| hu     | A stella alkalmazás munkaterületének előtérbe hozása     |
| lt     | Perkelti programos stella darbo sritį į priekinį planą   |
| lv     | Pārvietot lietotnes stella darbvietu priekšplānā         |
| pl     | Przenieś na wierzch obszar roboczy aplikacji stella      |
| pt-BR  | Trazer o espaço de trabalho da stella para a frente      |
| sk     | Preniesť do popredia pracovný priestor aplikácie stella  |

The editor and terminal labels are the same sentence with that locale's word
for the editor (the `footer.editor` descriptor) and for a terminal. Two rules
meet here: the verb takes the locale's action-label form (infinitive for cs,
sk, de, es, fr, lt, lv, pt-BR; imperative for pl and et; verbal noun for hu and
ar, matching `appearance.toggle`), and the brand rides its carrier noun from
the table at the top of this document, because "front" puts the phrase in a
case-bearing slot (cs _aplikace stella_, lt _programos stella_, lv _lietotnes
stella_, et _rakenduse stella_, pl _aplikacji stella_, hu _a stella
alkalmazás_). The locales that need no carrier take the bare brand.

The windows' visible titles stay as they are: "Microsoft Teams" is a
third-party proper noun, and "stella Editor" / "stella CLI" depict OS window
chrome rather than describing the product.

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
