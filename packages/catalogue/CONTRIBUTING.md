# Contributing to the Stella catalogue

The catalogue lists Skills, MCP servers, and first-party native tools
that users can install from inside Stella. It's open to community
contributions via PR.

## Adding an entry

1. Pick a `kind`: `skill`, `mcp`, or `native-tool`.
2. Create a folder at `entries/<kind>s/<your-slug>/`. Slug is
   kebab-case, 2–64 characters, unique within its kind.
3. Add `manifest.json` (see schema below) and a square `icon.svg`
   (≤32 KB recommended).
4. For `skill` entries: add the skill body next to the manifest and
   reference it via `entryPath` (e.g. `"SKILL.md"`). Optional
   resources go under `entryPath`-relative paths in `resources`.
5. Run `bun run --filter @stll/catalogue generate` to rebuild the
   generated manifest. Commit the regenerated file alongside your
   entry.
6. Run `bun run --filter @stll/catalogue validate` locally before
   pushing.
7. Open a PR. CI will re-run validation. A maintainer will review.

## Manifest fields

Common to all kinds:

| Field           | Required | Notes                                |
| --------------- | -------- | ------------------------------------ |
| `kind`          | yes      | `skill` \| `mcp` \| `native-tool`    |
| `slug`          | yes      | kebab-case, matches folder name      |
| `displayName`   | yes      | shown in the catalogue card          |
| `description`   | yes      | 1–2 sentences, plain language        |
| `author`        | yes      | name or org                          |
| `authorUrl`     | no       | author homepage                      |
| `license`       | yes      | SPDX id; permissive only (see below) |
| `pricing`       | yes      | `free` \| `paid` \| `freemium`       |
| `homepage`      | no       | project / docs URL                   |
| `tags`          | no       | search keywords                      |
| `jurisdictions` | no       | ISO 3166-1 alpha-2 codes (or `EU`)   |

Kind-specific fields are documented in `src/schema.ts`.

## Licence policy

In-tree catalogue entries must declare an OSI-approved permissive
licence. Accepted SPDX ids:

- `MIT`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`
- `ISC`
- `CC0-1.0`, `CC-BY-4.0` (for skill content / knowledge files)

Copyleft licences (GPL, AGPL, etc.) are rejected. This keeps
downstream redistribution and self-hosting unconstrained.

## Becoming "recommended"

The maintainer curates a small per-jurisdiction recommendation set
in `entries/recommended.json`. The public criteria are:

1. **Permissive licence.** Any in-tree entry qualifies by definition.
2. **Free for the user.** `pricing: "free"` strongly preferred.
3. **Maintained.** Author responds to issues; manifest accurate.
4. **Jurisdictionally relevant.** Tool is useful for actual legal
   practice in the listed jurisdiction.

`entries/recommended.json` is restricted to maintainers via
`.github/CODEOWNERS`. Edits to it by other contributors will be
blocked at PR time. If you think your entry deserves recommendation,
say so in the PR description — but landing the entry and earning
recommendation are separate decisions.

## Editing existing entries

Anyone can PR edits to any existing entry — typo fixes, jurisdictional
updates, better descriptions, version bumps. Treat skills and manifest
metadata like shared code: improvements welcome, breaking changes
flagged in the PR.
