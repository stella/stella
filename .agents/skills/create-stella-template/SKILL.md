---
name: create-stella-template
description: 'Turn an existing document (DOCX or plain text) into a Stella template by inserting {{markers}}. Use when asked to templatize a contract, power of attorney, or any document so its variable parts become fillable fields.'
---

# Create a Stella Template from an Existing File

Turn a finished document into a reusable Stella template: find the parts
that vary between instances and replace them with `{{markers}}`. The
document stays a normal DOCX; the markers are what make it fillable. The
marker grammar's single source of truth is
`packages/template-conditions/src/markers.ts` — never invent syntax
outside it.

## The marker vocabulary

Everything is `{{ ... }}`. There are exactly these kinds:

| Marker | Meaning |
| --- | --- |
| `{{path}}` | A fillable value. `path` is letters/digits/`_`/`-`/`.` only — e.g. `client_name`, `company.krs`. Dotted paths group related fields (`company.name`, `company.seat`). For repeated items use a numeric segment: `attorneys.0.name` (NEVER brackets). |
| `{{#if cond}}` … `{{/if}}` | Conditional block. The content shows only when `cond` is true. `{{#elseif other}}` and `{{#else}}` branch it. |
| `{{#each items}}` … `{{/each}}` | Repeats the content once per item in `items`. Reference each item's fields inside with the loop name, e.g. `{{items.name}}`. |
| `{{@clause:Name}}` | Inserts a library clause at fill time. `{{@clause:Name:v3}}` pins a version; `{{@clause:Name:latest}}` follows the head. |
| `{{@num:Key}}` / `{{@ref:Key}}` | Auto-numbering: `@num` assigns the next number to `Key`; `@ref` prints the number assigned to `Key`. |

Rules that matter:

- **Block markers (`#if`, `#each`, and their closers) must occupy their
  own paragraph.** An inline conditional phrase inside a sentence is
  supported, but a block that wraps paragraphs must open/close on its own
  lines.
- **Bilingual / multi-column documents:** the same value appears once per
  language column. Mark **every** occurrence with the **same** path
  (`{{company.name}}` in both the Polish and the English cell) — never
  leave one language hardcoded while the other is a field.
- Identical paths are the same field. Reusing `{{client_name}}` in ten
  places asks one question and fills all ten.

## Workflow

1. **Read the source.** If it's a DOCX, extract its text first
   (`apps/api/src/handlers/docx/extract-text.ts` patterns, or just read
   the visible content). Identify every span that would differ between
   two real uses of this document: names, addresses, registration
   numbers (KRS/NIP/REGON), dates, amounts, party roles, and any clause
   whose presence is optional.

2. **Choose a path for each.** Group with dots: a company's details are
   `company.name`, `company.seat`, `company.krs`. One party's fields share
   a prefix. Keep paths lowercase with underscores.

3. **Insert markers in place**, replacing the literal text. Optional
   passages get wrapped in `{{#if ...}}` / `{{/if}}` on their own lines;
   repeating rows (e.g. a list of lawyers) get `{{#each ...}}` /
   `{{/each}}`.

4. **Create the template.** Two paths:
   - **In-app / REST:** `PUT /templates` with multipart `{ file, name }` —
     the DOCX bytes plus a name. The server discovers the fields from the
     markers and embeds the manifest. See
     `apps/api/src/handlers/templates/create.ts`.
   - **Over MCP (external agent):** the `create_template` tool —
     `{ name, docx_base64 }` (base64-encoded DOCX). Same discovery.

5. **Verify.** After creation, the template's fields are whatever markers
   you placed. `describe_template` (chat tool or MCP) lists them back —
   confirm every variable part became a field and no literal value was
   left hardcoded.

## What you cannot set from the markers alone

Field *configuration* beyond the path — input type, a select's options,
"who fills this" (person / AI / lookup), a date format, a company-register
lookup — is set in the Studio's field face after creation, not in the
DOCX. The markers establish *which* values are fillable; the Studio
decides *how* each is filled. When templatizing, get the markers right
first; refine field config in the Studio (or via the manifest overlay the
REST create accepts).
