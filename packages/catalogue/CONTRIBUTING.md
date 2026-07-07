# Contributing to the Stella catalogue

The catalogue lists Skills, MCP servers, and first-party native tools
that users can install from inside Stella. It's open to community
contributions via PR.

## Adding an entry

1. Pick a `kind`: `skill`, `mcp`, or `native-tool`.
2. Create a folder at `entries/<kind>s/<your-slug>/`. Slug is
   kebab-case, 2–64 characters, unique across the catalogue.
3. Add `manifest.json` (see schema below). Add a square `icon.svg`
   or `icon.png` when the entry has an official icon.
4. For `skill` entries: pick a `source` (see "Skill sources" below).
5. Run `bun run --filter @stll/catalogue generate` to rebuild the
   generated manifest. Commit the regenerated file alongside your
   entry.
6. Run `bun run --filter @stll/catalogue validate` locally before
   pushing.
7. Open a PR. CI will re-run validation. A maintainer will review.

## Skill sources

A `skill` entry declares a `source`. The two shapes are a discriminated
union: only the fields listed for the chosen source are allowed.

### `source: "in-tree"`

The skill content lives in this repo, next to the manifest.

| Field       | Required | Notes                                     |
| ----------- | -------- | ----------------------------------------- |
| `source`    | yes      | `"in-tree"`                               |
| `entryPath` | yes      | skill body path, e.g. `"SKILL.md"`        |
| `resources` | no       | `entryPath`-relative paths to extra files |

Add the body and any resources to the entry folder. The per-entry
folder size cap (10 MB) applies, so keep large corpora out of the repo.

### `source: "github"`

The skill content stays upstream on GitHub, pinned to an immutable
commit. Use this for large community skills that should not enter this
repo. No content files may live in the entry folder: only `manifest.json`
and an optional icon.

| Field       | Required | Notes                                              |
| ----------- | -------- | -------------------------------------------------- |
| `source`    | yes      | `"github"`                                         |
| `repo`      | yes      | GitHub `owner/name` (identifier only, not a URL)   |
| `rev`       | yes      | full 40-char lowercase hex commit SHA              |
| `directory` | no       | skill directory in the repo; defaults to repo root |

The entry file is `SKILL.md` inside `directory`. Because content at a
pinned SHA is immutable, recommending a `github` skill still endorses
specific bytes: an upstream force-push cannot change what is served.

## Keeping `github` skills up to date

A scheduled workflow checks the upstream repo of each `github`-sourced
entry and, when the tracked branch has moved past the pinned `rev`,
opens a PR that bumps `rev` (dependabot-style). A maintainer reviews the
upstream diff before merging, so authors get updates through their own
GitHub while curation over specific bytes is preserved. Merging the bump
is a deliberate re-endorsement, not an automatic pointer.

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
| `cost`          | yes      | `free` \| `paid`                     |
| `setup`         | yes      | `none` \| `account` \| `api-key`     |
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
2. **Free for the user.** `cost: "free"` strongly preferred.
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
