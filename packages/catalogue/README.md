# Catalogue validation

`bun --filter @stll/catalogue check-pinned` validates every GitHub-sourced skill
against committed facts in `upstream/pinned-content.gen.json`, with network
access disabled by the shared offline-check preload. New or changed pins need
matching facts before the check can pass.

To refresh facts, run `bun --filter @stll/catalogue refresh-pinned` with network
access (and optionally `GITHUB_TOKEN` for the GitHub API rate limit). Refresh
fetches pinned files transiently, parses them with the install parser, validates
install limits and license matching, then writes the reduced snapshot only if
all entries pass. It retains identities, SHA-256 digests, byte and UTF-16
lengths, frontmatter name and license identifiers, field length projections,
and reduced directory listings. It retains no SKILL.md bodies, descriptive
frontmatter values, or resource contents. UTF-16 lengths match JavaScript's
`.length`, including the parser's normalized and trimmed body.

The snapshot binds the parser and acquisition implementation to the facts with
a source fingerprint and validates its canonical serialization and digest.
Parser changes require a refresh. This validates reviewed facts offline; the
committed content digest identifies the upstream bytes without retaining them.

The weekly upstream workflow refreshes revisions, generated catalogue outputs,
and pinned facts together through one maintained pull request. It uses an app
token so the proposal runs CI and never merges automatically.
