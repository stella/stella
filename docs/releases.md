# Releases

Stella releases are portable application artifacts. The public repository
publishes what any deploy system needs to run Stella, without tying releases to
Stella-specific deploy details.

## Public Release Contract

Each release tag (`vX.Y.Z` or `vX.Y.Z-rc.N`) publishes:

- a multi-architecture API image in the [GitHub Container Registry (GHCR)](https://docs.github.com/packages/working-with-a-github-packages-registry/working-with-the-container-registry),
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
   release notes. Stable releases are promoted automatically; the workflow does
   not succeed until `https://api.stll.app/health` reports the exact release
   commit. RCs continue to target staging.
6. After a stable release succeeds, `publish-npm.yml` checks out the same
   release commit, packs the CLI, installs that exact tarball under plain Node,
   and runs its unauthenticated compatibility canary against production. Only
   then can the hardened npm publishing job publish `@stll/cli`.

Changing `packages/cli/package.json` on `main` does not publish the CLI by
itself. This ordering is deliberate: the API must advertise support for the
packed CLI version and all of its resource scopes before the client becomes
public. A manual CLI publish is recovery-only and requires `release_ref` to
name the stable release currently served by production.

## API and CLI Compatibility

MCP protected-resource discovery publishes the versioned
`stella_compatibility` contract. It contains the API contract version and the
inclusive CLI version range supported by that server; `scopes_supported`
remains the authoritative OAuth resource-scope list.

Before expanding the CLI contract:

1. Add the API behavior and scopes, then raise the server's maximum supported
   CLI version.
2. Ship that API in a stable release.
3. Let the post-release exact-tarball canary publish the CLI.

The CLI intersects ordinary login requests with the authorization server's
advertised scopes, so an older server remains usable for capabilities it
actually supports. Explicitly requested scopes remain requirements and fail
before browser authorization when unavailable.

CI enforces the cross-boundary invariants as one contract: the API contract
number must match the CLI implementation, the API's maximum CLI version must
equal the package version, the published-version hint must remain within the
advertised range, and every packaged CLI scope must exist in the API's OAuth
and MCP scope sets. The canaried tarball's SHA-256 checksum is verified again
in the isolated OIDC publishing job, so npm receives those exact bytes.
