# Releases

Stella releases are portable application artifacts. The public repository
publishes what any deploy system needs to run Stella, without tying releases to
Stella-specific deploy details.

## Public Release Contract

Each release tag (`vX.Y.Z` or `vX.Y.Z-rc.N`) publishes:

- a multi-architecture API image in [GHCR](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry),
- immutable image references by tag, git SHA, and digest,
- a `release-manifest.json` file containing the source commit, image digest,
  and migration file inventory,
- GitHub release notes generated from merged changes, optionally prefixed with
  a manual description from `docs/changelog/<tag>.md`,
- a public changelog entry on `https://stll.app/changelog`, sourced from GitHub
  Releases.

The manifest is intentionally infra neutral. It names artifacts and migrations
only; environment-specific deploy details belong in the operator's private
infrastructure repository.

## Migration Policy

Production deploys should use explicit migration files from
`apps/api/drizzle/`. Do not use `drizzle-kit push` against production.

Schema changes should follow an expand/contract sequence:

1. Add backward-compatible schema first.
2. Deploy app code that can read/write both old and new shapes.
3. Backfill data in a separate, observable job when needed.
4. Remove obsolete schema only after every supported running version no longer
   depends on it.

Application rollback must not require database rollback. Destructive migrations
should lag the release that stopped using the old data.

## Creating A Release

1. Ensure CI is green on `main`.
2. Generate and review any required migration files.
3. In one commit, bump `VERSION` and optionally add the matching manual
   changelog note:

   ```bash
   printf "X.Y.Z\n" > VERSION
   $EDITOR docs/changelog/vX.Y.Z.md
   git add VERSION docs/changelog/vX.Y.Z.md
   git commit -m "chore: release vX.Y.Z"
   ```

   For RCs, use matching values such as `VERSION=1.2.3-rc.1` and
   `docs/changelog/v1.2.3-rc.1.md`.
4. Merge the commit to `main`. The `tag-on-version-bump.yml` workflow pushes
   the matching `vX.Y.Z` tag automatically. The tag then triggers
   `release.yml`.
5. Wait for the release workflow to publish the image, manifest, and GitHub
   release notes.
6. Promote the release from a private deploy repository or your own deployment
   system by consuming the manifest's immutable image digest.
