# Releases

Stella releases are portable application artifacts. The public repository
publishes what any deploy system needs to run Stella, without tying releases to
Stella-specific deploy details.

## Public Release Contract

Each release tag (`vX.Y.Z` or `vX.Y.Z-rc.N`) publishes:

- a multi-architecture API image in GHCR,
- immutable image references by tag, git SHA, and digest,
- a `release-manifest.json` file containing the source commit, image digest,
  and migration file inventory,
- GitHub release notes generated from merged changes.

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
3. Create a signed release tag:

   ```bash
   git tag -s vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

4. Wait for the release workflow to publish the image and manifest.
5. Promote the release from a private deploy repository or your own deployment
   system by consuming the manifest's immutable image digest.
