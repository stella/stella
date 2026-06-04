# Translation Terminology Guide

Rules for maintaining consistent translations across all locales.

## Supported Languages

| Code  | Language            | Plural forms                |
| ----- | ------------------- | --------------------------- |
| en    | English             | one, other                  |
| cs    | Czech               | one, few (2–4), other       |
| de    | German              | one, other                  |
| es    | Spanish             | one, many, other            |
| et    | Estonian            | one, other                  |
| fr    | French              | one, many, other            |
| hu    | Hungarian           | one, other                  |
| lt    | Lithuanian          | one, few (2–9), many, other |
| lv    | Latvian             | zero, one, other            |
| pl    | Polish              | one, few (2–4), many, other |
| pt-BR | Portuguese (Brazil) | one, many, other            |
| sk    | Slovak              | one, few (2–4), other       |

> Czech and Slovak also have a CLDR `many` category, but it only
> applies to fractional counts (e.g. 1.5); it is not needed for the
> integer counts used in UI strings, so it is omitted above. Keep
> `cs.json` and `sk.json` aligned on this — do not add unreachable
> integer `many` branches to one but not the other.

## Writing for an International Audience

**Our ICP is mid-size law firms (5–50 lawyers), globally.** Many
users read English as a second language. Follow these principles:

- **Use plain, professional English.** Avoid idioms, slang, and
  regional phrasing. Prefer internationally understood vocabulary.
  Write "sign in", not "log in" or "hop on". Write "remove", not
  "kick out".
- **Never dumb down.** Users are legal professionals. Use precise
  language; just avoid unnecessary complexity. "Delete" is better
  than "permanently remove from the system".
- **No technical jargon in user-facing text.** Write "one-time code",
  not "OTP". Write "verification code", not "2FA token". Backend
  logs can use technical terms; UI and emails cannot.
- **No standalone prepositions or conjunctions.** Never create
  translation keys for isolated words like "of", "and", "or", "to".
  These change with grammatical context in inflected languages
  (Czech, Slovak, Polish, Hungarian, German). Always use full
  phrases or sentences:
  - Bad: `{page}` + `t("of")` + `{total}` (assembled fragments)
  - Good: `{current} / {total}` (universal) or
    `t("pageOf", { current, total })` (full phrase)

## Key Naming Conventions

- **camelCase** for all keys: `createNewWorkspace`, not
  `create_new_workspace`
- **Nested by feature**: `workspaces.createNewWorkspace`, not
  `workspacesCreateNewWorkspace`
- **Namespaces** are the top-level keys of `en.json` (the
  authoritative list). Shared labels live in `common`; cross-cutting
  examples include `auth`, `navigation`, `workspaces`, `organization`,
  `errors`, `success`, `validation`. Check `en.json` for the current
  set — do not hardcode it here.
- **Reuse `common.*`; do not duplicate.** Before adding a key, search
  `en.json` for an existing value (especially under `common.*`) that
  already covers the concept. Prefer one generic key
  (`common.remove` = "Remove") over per-resource variants
  (`removeTag`, `removeMember`, `removeFile`) **when the string is a
  bare verb label**. The fewer keys, the less every locale has to
  re-translate. Caveat: a verb+noun phrase ("Remove member?") inflects
  the noun in cs/sk/pl/hu/de/lt/lv/et, so do **not** assemble it from a
  generic verb plus a noun fragment — keep such phrases whole (use
  `{name}` interpolation if the resource is dynamic).

## Action Verb Conventions

One translation per verb, used consistently across the product. These
are the canonical bare-label verbs (the values held by the `common.*`
keys, the single source of truth). Phrase verbs that always carry an
object ("Create matter", "Update column") are intentionally omitted —
their object inflects, so they live in feature keys, not here.

**Meanings that matter:** **Delete** = permanently erase data;
**Remove** = take away / detach (member, link, tag). Keep them
distinct in languages that distinguish them (cs, de, pt-BR); Romance
languages (es, fr) naturally collapse both to one verb — that is fine.

Slavic, Baltic, Germanic, Finno-Ugric:

| Verb         | Czech        | Slovak       | Polish      | German        | Estonian   | Hungarian     | Lithuanian  | Latvian      |
| ------------ | ------------ | ------------ | ----------- | ------------- | ---------- | ------------- | ----------- | ------------ |
| **Save**     | Uložit       | Uložiť       | Zapisz      | Speichern     | Salvesta   | Mentés        | Išsaugoti   | Saglabāt     |
| **Cancel**   | Zrušit       | Zrušiť       | Anuluj      | Abbrechen     | Tühista    | Mégse         | Atšaukti    | Atcelt       |
| **Confirm**  | Potvrdit     | Potvrdiť     | Potwierdź   | Bestätigen    | Kinnita    | Megerősítés   | Patvirtinti | Apstiprināt  |
| **Delete**   | Smazat       | Vymazať      | Usuń        | Löschen       | Kustuta    | Törlés        | Ištrinti    | Dzēst        |
| **Remove**   | Odebrat      | Odstrániť    | Usuń        | Entfernen     | Eemalda    | Eltávolítás   | Pašalinti   | Noņemt       |
| **Add**      | Přidat       | Pridať       | Dodaj       | Hinzufügen    | Lisa       | Hozzáadás     | Pridėti     | Pievienot    |
| **Edit**     | Upravit      | Upraviť      | Edytuj      | Bearbeiten    | Muuda      | Szerkesztés   | Redaguoti   | Rediģēt      |
| **Close**    | Zavřít       | Zavrieť      | Zamknij     | Schließen     | Sulge      | Bezárás       | Uždaryti    | Aizvērt      |
| **Send**     | Odeslat      | Odoslať      | Wyślij      | Senden        | Saada      | Küldés        | Siųsti      | Sūtīt        |
| **Download** | Stáhnout     | Stiahnuť     | Pobierz     | Herunterladen | Laadi alla | Letöltés      | Atsisiųsti  | Lejupielādēt |
| **Export**   | Exportovat   | Exportovať   | Eksportuj   | Exportieren   | Ekspordi   | Exportálás    | Eksportuoti | Eksportēt    |
| **Sign in**  | Přihlásit se | Prihlásiť sa | Zaloguj się | Anmelden      | Logi sisse | Bejelentkezés | Prisijungti | Pieslēgties  |
| **Sign out** | Odhlásit se  | Odhlásiť sa  | Wyloguj się | Abmelden      | Logi välja | Kijelentkezés | Atsijungti  | Atslēgties   |

Romance:

| Verb         | Spanish        | French         | Brazilian Portuguese |
| ------------ | -------------- | -------------- | -------------------- |
| **Save**     | Guardar        | Enregistrer    | Salvar               |
| **Cancel**   | Cancelar       | Annuler        | Cancelar             |
| **Confirm**  | Confirmar      | Confirmer      | Confirmar            |
| **Delete**   | Eliminar       | Supprimer      | Excluir              |
| **Remove**   | Eliminar       | Supprimer      | Remover              |
| **Add**      | Añadir         | Ajouter        | Adicionar            |
| **Edit**     | Editar         | Modifier       | Editar               |
| **Close**    | Cerrar         | Fermer         | Fechar               |
| **Send**     | Enviar         | Envoyer        | Enviar               |
| **Download** | Descargar      | Télécharger    | Baixar               |
| **Export**   | Exportar       | Exporter       | Exportar             |
| **Sign in**  | Iniciar sesión | Se connecter   | Faça login           |
| **Sign out** | Cerrar sesión  | Se déconnecter | Sair                 |

Note: cs **Remove** is "Odebrat" (not "Odstranit", which collides with
Delete); sk uses "Odstrániť" for Remove and "Vymazať" for Delete.

## Pluralization (ICU MessageFormat)

All pluralized strings use inline ICU syntax with `#` as the count
placeholder inside plural branches:

```json
{
  "deleteSelectedRowsDescription": "{count, plural, one {Delete # row?} other {Delete # rows?}}"
}
```

Czech and Slovak require `one`, `few`, and `other` forms.
Polish additionally requires `many` (5–21, 25–31, …):

```json
{
  "deleteSelectedRowsDescription": "{count, plural, one {Smazat # řádek?} few {Smazat # řádky?} other {Smazat # řádků?}}"
}
```

German, Hungarian, Estonian, and English use `one` and `other`.
Spanish and French use `one`, `many`, and `other`.
Lithuanian uses `one`, `few` (2–9), `many`, and `other`.
Latvian uses `zero`, `one`, and `other`.
Brazilian Portuguese uses `one`, `many`, and `other`; in normal UI
counts, `many` usually shares the `other` wording.

Use `#` inside plural branches (standard ICU placeholder).
Use `{count}` outside of plural branches for simple interpolation.

## Interpolation

Use `{variable}` syntax (ICU standard, single braces):

```json
{
  "weSentCodeTo": "We sent a code to {email}",
  "createdAt": "Created at {date}"
}
```

**Every locale must carry the same placeholders as `en.json`.** A
translation that drops `{query}` or renames `{email}` is a silent
runtime bug the type system cannot catch (only the en source is typed).

## ICU Escaping (apostrophes & literal braces)

ICU MessageFormat (via `use-intl`) treats `'` and `{` `}` `#` as
syntax. This bites translators in two ways:

- **Apostrophes.** A lone `'` is a literal apostrophe **unless** it is
  immediately followed by `{`, `}`, or `#` — then it starts a quoted
  section that runs until the next `'`, silently swallowing text or a
  placeholder. French/Italian-style apostrophes (`l'organisation`,
  `n'est`) are safe because they are not adjacent to a brace. Only the
  brace-adjacent case is dangerous.
- **Literal braces.** To show a literal `{` `}` (e.g. a token like
  `{SEQ}`), escape **each token self-contained**: `'{'SEQ'}'`. Do
  **not** use the whole-string form `'{SEQ}'` — it relies on
  apostrophes balancing across the entire string, so one stray
  apostrophe elsewhere silently extends the quote. The canonical
  examples live in `organization.matterNumber.*`:

  ```json
  "patternMustContainSeq": "Pattern must contain '{'SEQ'}'"
  ```

## Quotation Marks

Quotation marks are locale-specific typography. When a string quotes
an interpolated value (e.g. `Saved as "{fileName}"`), use the target
locale's marks, not the ASCII `"…"` from the English source:

| Locale     | Marks   | Codepoints      |
| ---------- | ------- | --------------- |
| en         | `"…"`   | U+0022          |
| cs, sk     | `„…"`   | U+201E … U+201C |
| de         | `„…"`   | U+201E … U+201C |
| et, lt     | `„…"`   | U+201E … U+201C |
| hu, pl, lv | `„…”`   | U+201E … U+201D |
| es         | `«…»`   | U+00AB … U+00BB |
| fr         | `« … »` | U+00AB … U+00BB |
| pt-BR      | `“…”`   | U+201C … U+201D |

The low/high distinction matters: cs/sk/de/et/lt close with the
high-left `"` (U+201C); hu/pl/lv close with the high-right `”`
(U+201D). French inserts a space inside the guillemets (ideally a
narrow no-break space, U+202F).

## Type Safety (Codegen)

After adding or modifying keys in `en.json`, regenerate the type
declarations (`langs/messages.gen.ts`) so TypeScript can enforce
interpolation parameters. From `apps/web`:

```bash
bun run typegen
```

Typegen does **not** run as part of `bun run typecheck`. Run it
manually after editing `en.json`, or rely on the validation gate:

```bash
bun run i18n:check   # typegen --check (drift) + locale structure check
bun run i18n:sync    # fill missing keys from en + sort + regenerate types
```

`i18n:sync` runs on pre-commit and `i18n:check` on pre-push (see
`lefthook.yml`). Note: `i18n:sync` fills _missing_ keys with the
English value, so a freshly-synced key ships as English until it is
translated — the untranslated-value check (below) guards against
that shipping silently.

## Date and Number Formatting

Do NOT embed formatted dates or numbers in translation strings.
Use `Intl.DateTimeFormat` and `Intl.NumberFormat` with the user's
locale, then pass the result as an interpolation variable.

## Style Rules

- **Sentence case** for all UI text (not Title Case): "Create new
  workspace", not "Create New Workspace". Exception: German nouns
  (capitalized per grammar). The product name is spelled **stella**
  (lowercase) in all user-facing text.
- **No trailing punctuation** on button labels: "Save changes",
  not "Save changes."
- **Ellipsis for loading states**: "Uploading files...", not
  "Uploading files"
- **Error messages start with "Failed to"** in English. Each
  language should follow its own natural error phrasing.

## Legal Terminology

Legal terms should be translated by native speakers with legal
knowledge. The core glossary below is peer-validated against
legal-tech vendors and official sources in each market. **Use one
term per concept per language, consistently across the product.**
When introducing a new legal concept not listed here, and in doubt,
leave the English term in parentheses — e.g. `Spis (Matter)` — until
it can be confirmed.

**Matter** is the load-bearing term (the client-engagement workspace).
It must not drift into synonyms. The audit found competing renderings
that should be unified onto the canonical term: et `toimik` vs
`asi`/`kohtuasi`; de `Akte` vs `Sache`/`Mandat`; sk `Spis` vs `Vec`.
The internal "workspace" alias means the same thing where it is
user-facing (`createNewWorkspace` = "Create new matter"); render it
with the Matter term, not a literal "pracovní prostor" / "espace de
travail" / "tööruum".

Slavic, Baltic, Germanic, Finno-Ugric:

| Concept      | Czech      | Slovak     | Polish         | German         | Estonian      | Hungarian            | Lithuanian      | Latvian      |
| ------------ | ---------- | ---------- | -------------- | -------------- | ------------- | -------------------- | --------------- | ------------ |
| **Matter**   | Spis       | Spis       | Sprawa         | Akte           | Toimik        | Ügy                  | Byla            | Lieta        |
| **Case law** | Judikatura | Judikatúra | Orzecznictwo   | Rechtsprechung | Kohtupraktika | Ítélkezési gyakorlat | Teismų praktika | Tiesu prakse |
| **Court**    | Soud       | Súd        | Sąd            | Gericht        | Kohus         | Bíróság              | Teismas         | Tiesa        |
| **Party**    | Strana     | Strana     | Strona         | Partei         | Osapool       | Fél                  | Šalis           | Puse         |
| **Clause**   | Doložka    | Klauzula   | Klauzula       | Klausel        | Klausel       | Kikötés              | Sąlyga          | Klauzula     |
| **Template** | Šablona    | Vzor       | Szablon        | Vorlage        | Mall          | Sablon               | Šablonas        | Veidne       |
| **Folder**   | Složka     | Priečinok  | Folder         | Ordner         | Kaust         | Mappa                | Aplankas        | Mape         |
| **Tag**      | Štítek     | Štítok     | Tag            | Schlagwort     | Silt          | Címke                | Žyma            | Birka        |
| **Draft**    | Koncept    | Koncept    | Wersja robocza | Entwurf        | Mustand       | Piszkozat            | Juodraštis      | Melnraksts   |
| **Contact**  | Kontakt    | Kontakt    | Kontakt        | Kontakt        | Kontakt       | Kapcsolat            | Kontaktas       | Kontakts     |

Romance:

| Concept      | Spanish        | French        | Brazilian Portuguese |
| ------------ | -------------- | ------------- | -------------------- |
| **Matter**   | Asunto         | Dossier       | Caso                 |
| **Case law** | Jurisprudencia | Jurisprudence | Jurisprudência       |
| **Court**    | Tribunal       | Juridiction   | Tribunal             |
| **Party**    | Parte          | Partie        | Parte                |
| **Clause**   | Cláusula       | Clause        | Cláusula             |
| **Template** | Plantilla      | Modèle        | Modelo               |
| **Folder**   | Carpeta        | Dossier       | Pasta                |
| **Tag**      | Etiqueta       | Étiquette     | Etiqueta             |
| **Draft**    | Borrador       | Brouillon     | Rascunho             |
| **Contact**  | Contacto       | Contact       | Contato              |

Notes:

- **de Tag** = "Schlagwort/Schlagwörter" (standard German DMS term, not
  "Tags"). **fr Court** = "Juridiction" (deliberate: matches the
  Judilibre open-data umbrella; "Tribunal" is too narrow).
- **fr Dossier** serves both Matter and Folder; the collision is
  idiomatic and unavoidable, context disambiguates.
- **sk Template** prefers "Vzor" (native legal-document register) over
  "Šablóna". **cs Clause**: "Doložka" for a clause library; "Klauzule"
  is acceptable.
- **lv Case law** = "Tiesu prakse" for a broad decisions database;
  reserve "Judikatūra" for binding Supreme-Court precedent only.

### Brazilian Portuguese

Use Brazilian legal and law-firm terminology, not generic Portuguese:

| English          | pt-BR                       | Notes                                                                                  |
| ---------------- | --------------------------- | -------------------------------------------------------------------------------------- |
| Matter           | Caso                        | Product workspace for client/legal work; use `processo` only for judicial proceedings. |
| Matters          | Casos                       | Avoid `assuntos`, which reads like generic topics.                                     |
| Case law         | Jurisprudência              | Use for precedent/court decision databases.                                            |
| Case number      | Número do processo          | Use when referring to court decisions or judicial proceedings.                         |
| Court            | Tribunal                    | Use for court metadata; `vara` is too specific.                                        |
| Party            | Parte                       | Legal party in a matter/process.                                                       |
| Opposing party   | Parte contrária             | Standard adversarial role.                                                             |
| Opposing counsel | Advogado da parte contrária | Clearer than literal `conselho oposto`.                                                |
| Expert witness   | Perito                      | Brazilian procedural role; avoid literal `testemunha especialista`.                    |
| Tracked changes  | Controle de alterações      | Microsoft Word UI term in Brazilian Portuguese.                                        |
