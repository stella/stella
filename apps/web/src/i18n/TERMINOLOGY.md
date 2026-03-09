# Translation Terminology Guide

Rules for maintaining consistent translations across all locales.

## Supported Languages

| Code | Language   | Plural forms                |
| ---- | ---------- | --------------------------- |
| en   | English    | one, other                  |
| cs   | Czech      | one, few (2–4), other       |
| de   | German     | one, other                  |
| es   | Spanish    | one, many, other            |
| et   | Estonian   | one, other                  |
| fr   | French     | one, many, other            |
| hu   | Hungarian  | one, other                  |
| lt   | Lithuanian | one, few (2–9), many, other |
| lv   | Latvian    | zero, one, other            |
| pl   | Polish     | one, few (2–4), many, other |
| sk   | Slovak     | one, few (2–4), other       |

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
- **Namespaces**: `common`, `auth`, `emails`, `navigation`,
  `workspaces`, `organization`, `errors`, `success`, `validation`
- **No duplicates across namespaces.** Before adding a new key,
  check if an existing key already covers the same concept. Reuse
  existing keys when the meaning and context match.

## Action Verb Conventions

Use these verbs consistently across all languages:

| English verb | Meaning                           | Czech        | German        | Polish      | Slovak       | Hungarian     |
| ------------ | --------------------------------- | ------------ | ------------- | ----------- | ------------ | ------------- |
| **Create**   | Make something new                | Vytvořit     | Erstellen     | Utworzyć    | Vytvoriť     | Létrehozás    |
| **Delete**   | Permanently remove                | Smazat       | Löschen       | Usuń        | Vymazať      | Törlés        |
| **Remove**   | Take away (e.g., member from org) | Odebrat      | Entfernen     | Usuń        | Odstrániť    | Eltávolítás   |
| **Update**   | Modify existing                   | Aktualizovat | Aktualisieren | Zaktualizuj | Aktualizovať | Frissítés     |
| **Cancel**   | Abort an action                   | Zrušit       | Abbrechen     | Anuluj      | Zrušiť       | Mégse         |
| **Save**     | Persist changes                   | Uložit       | Speichern     | Zapisz      | Uložiť       | Mentés        |
| **Send**     | Dispatch (invitation, email)      | Odeslat      | Senden        | Wyślij      | Odoslať      | Küldés        |
| **Sign in**  | Authenticate                      | Přihlásit se | Anmelden      | Zaloguj się | Prihlásiť sa | Bejelentkezés |
| **Sign out** | End session                       | Odhlásit se  | Abmelden      | Wyloguj się | Odhlásiť sa  | Kijelentkezés |

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

## Type Safety (Codegen)

After adding or modifying keys in `en.json`, regenerate the type
declarations so TypeScript can enforce interpolation parameters:

```bash
bun scripts/generate-i18n-types.ts
```

This runs automatically before `bun run typecheck` via the
`pretypecheck` script.

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
knowledge. When in doubt, leave the English term in parentheses:

> Spis (Matter)

This ensures clarity while we build proper legal glossaries per
jurisdiction.
